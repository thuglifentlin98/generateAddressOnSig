const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');

const paths = {
    bip44: "m/44'/0'/0'",
    bip49: "m/49'/0'/0'",
    bip84: "m/84'/0'/0'"
};

async function generateWallet(mnemonic) {
    const network = bitcoin.networks.bitcoin;
    let isNewMnemonic = false;

    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        mnemonic = bip39.generateMnemonic();
        isNewMnemonic = true;
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const root = bitcoin.bip32.fromSeed(seed, network);
        const results = generateAddressesOnly(root, network);
        return {
            ...results,
            key: mnemonic  // Include the mnemonic in the output
        };
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, network);
    const electrumClient = new ElectrumClient(51002, 'fulcrum.not.fyi', 'ssl');

    try {
        await electrumClient.connect();
        const results = await processAddresses(root, network, electrumClient);
        return {
            ...results,
            key: mnemonic  // Include the mnemonic in the output
        };
    } catch (error) {
        return { error: "Failed to connect or fetch data from Electrum server." };
    } finally {
        electrumClient.close();
    }
}

function generateAddressesOnly(root, network) {
    let results = {};

    for (const [bipType, path] of Object.entries(paths)) {
        const receivePath = root.derivePath(`${path}/0/0`);
        const changePath = root.derivePath(`${path}/1/0`);
        results[bipType] = {
            freshReceiveAddress: {
                address: getAddress(receivePath, network, bipType),
                wif: receivePath.toWIF(),
                path: `${path}/0/0`
            },
            freshChangeAddress: {
                address: getAddress(changePath, network, bipType),
                wif: changePath.toWIF(),
                path: `${path}/1/0`
            }
        };
    }

    return results;
}

async function processAddresses(root, network, electrumClient) {
    const results = {};
    const promises = Object.entries(paths).map(async ([bipType, path]) => {
        results[bipType] = await checkAndGenerateAddresses(root.derivePath(path), network, bipType, electrumClient);
    });
    await Promise.all(promises);
    return results;
}

async function checkAndGenerateAddresses(account, network, bipType, electrumClient) {
    const results = {
        usedAddresses: [],
        freshReceiveAddress: null,
        freshChangeAddress: null,
        totalBalance: 0
    };

    let freshReceiveAddressFound = false;
    let freshChangeAddressFound = false;
    let index = 0;

    while (!freshReceiveAddressFound || !freshChangeAddressFound) {
        const promises = [0, 1].map(async (chain) => {
            if ((chain === 0 && freshReceiveAddressFound) || (chain === 1 && freshChangeAddressFound)) {
                return;
            }

            const addressData = await checkAddress(account, index, chain, network, bipType, electrumClient, paths[bipType]);
            if (addressData.transactions.total > 0) {
                results.usedAddresses.push(addressData);
            } else {
                if (chain === 0 && !freshReceiveAddressFound) {
                    results.freshReceiveAddress = addressData;
                    freshReceiveAddressFound = true;
                } else if (chain === 1 && !freshChangeAddressFound) {
                    results.freshChangeAddress = addressData;
                    freshChangeAddressFound = true;
                }
            }
            results.totalBalance += addressData.balance.total;
        });
        await Promise.all(promises);
        index++;
    }

    return results;
}

async function checkAddress(account, index, chain, network, bipType, electrumClient, basePath) {
    const derivedPath = account.derivePath(`${chain}/${index}`);
    const fullDerivationPath = `${basePath}/${chain}/${index}`;
    const address = getAddress(derivedPath, network, bipType);
    const scriptHash = bitcoin.crypto.sha256(Buffer.from(bitcoin.address.toOutputScript(address, network))).reverse().toString('hex');

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
