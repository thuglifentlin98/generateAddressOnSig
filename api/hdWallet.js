const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');
const generatePubKeys = require('./generatePUB');

const paths = {
    bip44: "m/44'/0'/0'",
    bip49: "m/49'/0'/0'",
    bip84: "m/84'/0'/0'"
};

const BATCH_SIZE = 100; // Adjust the batch size as needed
const electrumServers = [
    { host: 'fulcrum.sethforprivacy.com', port: 50002, protocol: 'ssl' },
    { host: 'mempool.blocktrainer.de', port: 50002, protocol: 'ssl' },
    { host: 'fulcrum.grey.pw', port: 51002, protocol: 'ssl' },
    { host: 'fortress.qtornado.com', port: 50002, protocol: 'ssl' },
    { host: 'electrumx-core.1209k.com', port: 50002, protocol: 'ssl' },
    { host: 'pipedream.fiatfaucet.com', port: 50002, protocol: 'ssl' },
    // Add more servers as needed
];

async function connectToElectrumServer() {
    for (const server of electrumServers) {
        const electrumClient = new ElectrumClient(server.port, server.host, server.protocol);
        try {
            await electrumClient.connect();
            return electrumClient;
        } catch (error) {
            console.error(`Failed to connect to Electrum server ${server.host}:`, error);
        }
    }
    throw new Error('All Electrum servers failed to connect');
}

async function generateWallet(mnemonic) {
    const network = bitcoin.networks.bitcoin;
    let isNewMnemonic = false;

    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        mnemonic = bip39.generateMnemonic();
        isNewMnemonic = true;
    }

    const pubKeys = generatePubKeys(mnemonic);
    if (!pubKeys) {
        return { error: "Invalid mnemonic." };
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, network);
    let electrumClient;
    try {
        electrumClient = await connectToElectrumServer();
        const results = await processAddressesForAllBipTypes(root, network, electrumClient);
        return {
            ...results,
            key: mnemonic,
            pubKeys
        };
    } catch (error) {
        console.error('Electrum client error:', error); // Log the error
        return { error: "Failed to connect or fetch data from any Electrum server." };
    } finally {
        if (electrumClient) {
            electrumClient.close();
        }
    }
}

async function processAddressesForAllBipTypes(root, network, electrumClient) {
    let results = {};
    for (const [bipType, path] of Object.entries(paths)) {
        results[bipType] = await processAddressesRecursively(root, network, electrumClient, bipType, path, 0, BATCH_SIZE);
    }
    return results;
}

async function processAddressesRecursively(root, network, electrumClient, bipType, path, start, batchSize) {
    let account = root.derivePath(path);
    let results = await checkAndGenerateAddresses(account, network, bipType, electrumClient, start, batchSize);

    while (!results.freshReceiveAddress || !results.freshChangeAddress) {
        start += batchSize;
        const nextBatchResults = await checkAndGenerateAddresses(account, network, bipType, electrumClient, start, batchSize);
        results.usedAddresses.push(...nextBatchResults.usedAddresses);
        results.totalBalance += nextBatchResults.totalBalance;
        if (!results.freshReceiveAddress) results.freshReceiveAddress = nextBatchResults.freshReceiveAddress;
        if (!results.freshChangeAddress) results.freshChangeAddress = nextBatchResults.freshChangeAddress;
    }

    return results;
}

async function checkAndGenerateAddresses(account, network, bipType, electrumClient, start, batchSize) {
    let results = {
        usedAddresses: [],
        freshReceiveAddress: null,
        freshChangeAddress: null,
        totalBalance: 0
    };

    let tasks = [];
    for (let i = start; i < start + batchSize; i++) {
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
