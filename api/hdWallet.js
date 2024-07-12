const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');
const generatePubKeys = require('./generatePUB'); // Ensure this path is correct

// Define the derivation paths for BIP44, BIP49, and BIP84
const derivationPaths = {
    BIP44: "m/44'/0'/0'",
    BIP49: "m/49'/0'/0'",
    BIP84: "m/84'/0'/0'"
};

// Define the electrum servers
const electrumServers = [
    { host: 'fulcrum.sethforprivacy.com', port: 50002, protocol: 'ssl' },
    { host: 'mempool.blocktrainer.de', port: 50002, protocol: 'ssl' },
    { host: 'fulcrum.grey.pw', port: 51002, protocol: 'ssl' },
    { host: 'fortress.qtornado.com', port: 50002, protocol: 'ssl' },
    { host: 'electrumx-core.1209k.com', port: 50002, protocol: 'ssl' },
    { host: 'pipedream.fiatfaucet.com', port: 50002, protocol: 'ssl' },
    // Add more servers as needed
];

// Function to create a new Electrum client
const createElectrumClient = async () => {
    for (let server of electrumServers) {
        const client = new ElectrumClient(server.port, server.host, server.protocol);
        try {
            await client.connect();
            return client;
        } catch (e) {
            console.error(`Failed to connect to server ${server.host}:${server.port}`);
        }
    }
    throw new Error('Failed to connect to any Electrum server');
};

// Function to generate addresses from a given seed and derivation path
const generateAddresses = (seed, path, start, count, type, change) => {
    const root = bitcoin.bip32.fromSeed(seed);
    const addresses = [];
    for (let i = start; i < start + count; i++) {
        const child = root.derivePath(`${path}/${change}/${i}`);
        let address, wif;
        switch (type) {
            case 'BIP44':
                address = bitcoin.payments.p2pkh({ pubkey: child.publicKey }).address;
                break;
            case 'BIP49':
                address = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: child.publicKey }) }).address;
                break;
            case 'BIP84':
                address = bitcoin.payments.p2wpkh({ pubkey: child.publicKey }).address;
                break;
        }
        wif = child.toWIF();
        addresses.push({ address, wif, path: `${path}/${change}/${i}` });
    }
    return addresses;
};

// Function to convert address to Electrum scripthash format
const toElectrumScripthash = (address) => {
    const script = bitcoin.address.toOutputScript(address);
    const hash = bitcoin.crypto.sha256(script);
    return Buffer.from(hash.reverse()).toString('hex');
};

// Function to check transaction history and balance for a list of addresses
const checkTransactionHistoryAndBalance = async (client, addresses) => {
    const promises = addresses.map(async addrObj => {
        const scripthash = toElectrumScripthash(addrObj.address);
        const history = await client.blockchainScripthash_getHistory(scripthash);
        const utxos = await client.blockchainScripthash_listunspent(scripthash);
        const balance = await client.blockchainScripthash_getBalance(scripthash);

        addrObj.balance = {
            confirmed: balance.confirmed,
            unconfirmed: balance.unconfirmed,
            total: balance.confirmed + balance.unconfirmed
        };
        addrObj.transactions = {
            confirmed: history.filter(tx => tx.height > 0).length,
            unconfirmed: history.filter(tx => tx.height <= 0).length,
            total: history.length
        };
        addrObj.utxos = utxos;

        return history.length > 0 ? addrObj : null;
    });

    const usedAddresses = await Promise.all(promises);
    return usedAddresses.filter(addr => addr !== null);
};

// Function to process addresses for a single derivation path
const processAddresses = async (client, seed, type, path) => {
    let count = 10;
    let results = { usedAddresses: [], totalBalance: 0, freshReceiveAddress: null, freshChangeAddress: null };
    let start = 0;
    let foundReceive = false;
    let foundChange = false;
    let lastUsedReceiveIndex = -1;
    let lastUsedChangeIndex = -1;

    while (!foundReceive || !foundChange) {
        const receiveAddresses = generateAddresses(seed, path, start, count, type, 0);
        const changeAddresses = generateAddresses(seed, path, start, count, type, 1);

        console.log(`Checking ${count} receive addresses and ${count} change addresses for ${type} starting from ${start}`);

        const [usedReceiveAddresses, usedChangeAddresses] = await Promise.all([
            checkTransactionHistoryAndBalance(client, receiveAddresses),
            checkTransactionHistoryAndBalance(client, changeAddresses)
        ]);

        if (usedReceiveAddresses.length > 0) {
            results.usedAddresses.push(...usedReceiveAddresses);
            results.totalBalance += usedReceiveAddresses.reduce((sum, addr) => sum + addr.balance.total, 0);
            lastUsedReceiveIndex = Math.max(lastUsedReceiveIndex, ...usedReceiveAddresses.map(addr => parseInt(addr.path.split('/').pop())));
        } else {
            foundReceive = true;
        }

        if (usedChangeAddresses.length > 0) {
            results.usedAddresses.push(...usedChangeAddresses);
            results.totalBalance += usedChangeAddresses.reduce((sum, addr) => sum + addr.balance.total, 0);
            lastUsedChangeIndex = Math.max(lastUsedChangeIndex, ...usedChangeAddresses.map(addr => parseInt(addr.path.split('/').pop())));
        } else {
            foundChange = true;
        }

        start += count;
        count *= 2;
    }

    results.freshReceiveAddress = generateAddresses(seed, path, lastUsedReceiveIndex + 1, 1, type, 0)[0];
    results.freshChangeAddress = generateAddresses(seed, path, lastUsedChangeIndex + 1, 1, type, 1)[0];

    return { type, results };
};

const generateWallet = async (mnemonic) => {
    const pubKeys = generatePubKeys(mnemonic);
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const client = await createElectrumClient();

    const tasks = Object.entries(derivationPaths).map(([type, path]) => processAddresses(client, seed, type, path));
    const resultsArray = await Promise.all(tasks);

    const results = resultsArray.reduce((acc, { type, results }) => {
        acc[type] = results;
        return acc;
    }, {});

    await client.close();

    // Add the pubKeys to the results
    results.key = mnemonic;
    results.pubKeys = pubKeys;

    return results;
};

module.exports = { generateWallet };
