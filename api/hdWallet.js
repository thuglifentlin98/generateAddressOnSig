const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');

// Paths for global scope as they are used in multiple functions.
const paths = {
    bip44: "m/44'/0'/0'",
    bip49: "m/49'/0'/0'",
    bip84: "m/84'/0'/0'"
};

const BATCH_SIZE = 100; // Adjust the batch size as needed

async function generateWallet(mnemonic, start = 0, end = BATCH_SIZE) {
    const network = bitcoin.networks.bitcoin;
    let isNewMnemonic = false;

    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        mnemonic = bip39.generateMnemonic();
        isNewMnemonic = true;
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const root = bitcoin.bip32.fromSeed(seed, network);
        const results = generateAddressesOnly(root, network, start, end);
        return {
            ...results,
            key: mnemonic
        };
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, network);
    const electrumClient = new ElectrumClient(51002, 'fulcrum.not.fyi', 'ssl');

    try {
        await electrumClient.connect();
        const results = await processAddressesRecursively(root, network, electrumClient, start, end);
        return {
            ...results,
            key: mnemonic
        };
    } catch (error) {
        return { error: "Failed to connect or fetch data from Electrum server." };
    } finally {
        electrumClient.close();
    }
}

function generateAddressesOnly(root, network, start, end) {
    let results = {};
    for (const [bipType, path] of Object.entries(paths)) {
        for (let i = start; i < end; i++) {
            const receivePath = root.derivePath(`${path}/0/${i}`);
            const changePath = root.derivePath(`${path}/1/${i}`);
            results[bipType] = results[bipType] || {
                freshReceiveAddress: [],
                freshChangeAddress: []
            };
            results[bipType].freshReceiveAddress.push({
                address: getAddress(receivePath, network, bipType),
                wif: receivePath.toWIF(),
                path: `${path}/0/${i}`
            });
            results[bipType].freshChangeAddress.push({
                address: getAddress(changePath, network, bipType),
                wif: changePath.toWIF(),
                path: `${path}/1/${i}`
            });
        }
    }
    return results;
}

async function processAddressesRecursively(root, network, electrumClient, start, end) {
    let results = {};
    let freshReceiveAddressFound = false;
    let freshChangeAddressFound = false;
    
    for (const [bipType, path] of Object.entries(paths)) {
        let account = root.derivePath(path);
        results[bipType] = await checkAndGenerateAddressesRecursively(account, network, bipType, electrumClient, start, end);
        if (results[bipType].freshReceiveAddress && results[bipType].freshChangeAddress) {
            freshReceiveAddressFound = true;
            freshChangeAddressFound = true;
        }
    }
    
    if (!freshReceiveAddressFound || !freshChangeAddressFound) {
        return await processAddressesRecursively(root, network, electrumClient, end, end + BATCH_SIZE);
    }

    return results;
}

async function checkAndGenerateAddressesRecursively(account, network, bipType, electrumClient, start, end) {
    let results = {
        usedAddresses: [],
        freshReceiveAddress: null,
        freshChangeAddress: null,
        totalBalance: 0
    };

    let tasks = [];
    for (let i = start; i < end; i++) {
        for (const chain of [0, 1]) {
            tasks.push(checkAddress(account, i, chain, network, bipType, electrumClient, paths[bipType])
                .then(addressData => {
                    if (addressData.transactions.total > 0) {
                        results.usedAddresses.push(addressData);
                    } else {
                        if (chain === 0 && !results.freshReceiveAddress) {
                            results.freshReceiveAddress = addressData;
                        } else if (chain === 1 && !results.freshChangeAddress) {
                            results.freshChangeAddress = addressData;
                        }
                    }
                    results.totalBalance += addressData.balance.total;
                }));
        }

        if (tasks.length >= 10) {
            await Promise.all(tasks);
            tasks = [];
        }
    }

    if (tasks.length > 0) {
        await Promise.all(tasks);
    }

    return results;
}

async function checkAddress(account, index, chain, network, bipType, electrumClient, basePath) {
    let derivedPath = account.derivePath(`${chain}/${index}`);
    let fullDerivationPath = `${basePath}/${chain}/${index}`;
    let address = getAddress(derivedPath, network, bipType);
    let scriptHash = bitcoin.crypto.sha256(Buffer.from(bitcoin.address.toOutputScript(address, network))).reverse().toString('hex');

    const [history, balance] = await Promise.all([
        electrumClient.blockchainScripthash_getHistory(scriptHash),
        electrumClient.blockchainScripthash_getBalance(scriptHash)
    ]);

    let utxos = [];
    if (history.length > 0) {
        utxos = await electrumClient.blockchainScripthash_listunspent(scriptHash);
    }

    return {
        address,
        wif: derivedPath.toWIF(),
        path: fullDerivationPath,
        balance: {
            confirmed: balance.confirmed,
            unconfirmed: balance.unconfirmed,
            total: balance.confirmed + balance.unconfirmed
        },
        transactions: {
            confirmed: history.filter(tx => tx.height !== 0).length,
            unconfirmed: history.filter(tx => tx.height === 0).length,
            total: history.length
        },
        utxos: utxos.map(utxo => ({
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            amount: utxo.value,
            status: utxo.height === 0 ? 'unconfirmed' : 'confirmed'
        }))
    };
}

function getAddress(derivedPath, network, bipType) {
    switch (bipType) {
        case 'bip44':
            return bitcoin.payments.p2pkh({ pubkey: derivedPath.publicKey, network }).address;
        case 'bip49':
            return bitcoin.payments.p2sh({
                redeem: bitcoin.payments.p2wpkh({ pubkey: derivedPath.publicKey, network })
            }).address;
        case 'bip84':
            return bitcoin.payments.p2wpkh({ pubkey: derivedPath.publicKey, network }).address;
        default:
            throw new Error('Unsupported BIP type');
    }
}

module.exports = { generateWallet };
