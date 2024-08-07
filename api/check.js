const bitcoin = require('bitcoinjs-lib');
const bip39 = require('bip39');
const ElectrumClient = require('electrum-client');
const generatePubKeys = require('./generatePUB');

const electrumServers = [
    { host: 'fulcrum.sethforprivacy.com', port: 50002, protocol: 'ssl' },
    { host: 'mempool.blocktrainer.de', port: 50002, protocol: 'ssl' },
    { host: 'fulcrum.grey.pw', port: 51002, protocol: 'ssl' },
    { host: 'fortress.qtornado.com', port: 50002, protocol: 'ssl' },
    { host: 'electrumx-core.1209k.com', port: 50002, protocol: 'ssl' },
    { host: 'pipedream.fiatfaucet.com', port: 50002, protocol: 'ssl' },
    // Add more servers as needed
];

const network = bitcoin.networks.bitcoin;

function isValidMnemonic(mnemonic) {
    return bip39.validateMnemonic(mnemonic);
}

function isValidWIF(wif) {
    try {
        bitcoin.ECPair.fromWIF(wif, network);
        return true;
    } catch (e) {
        return false;
    }
}

function generateAddressesFromMnemonic(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, network);

    const addresses = {
        bip84: { receive: [], change: [] },
        bip49: { receive: [], change: [] },
        bip44: { receive: [], change: [] }
    };

    for (let i = 0; i < 6; i++) {
        addresses.bip84.receive.push({ address: generateAddress(root, `m/84'/0'/0'/0/${i}`, bitcoin.payments.p2wpkh), path: `m/84'/0'/0'/0/${i}`, child: root.derivePath(`m/84'/0'/0'/0/${i}`) });
        addresses.bip84.change.push({ address: generateAddress(root, `m/84'/0'/0'/1/${i}`, bitcoin.payments.p2wpkh), path: `m/84'/0'/0'/1/${i}`, child: root.derivePath(`m/84'/0'/0'/1/${i}`) });

        addresses.bip49.receive.push({ address: generateP2SH_P2WPKH_Address(root, `m/49'/0'/0'/0/${i}`), path: `m/49'/0'/0'/0/${i}`, child: root.derivePath(`m/49'/0'/0'/0/${i}`) });
        addresses.bip49.change.push({ address: generateP2SH_P2WPKH_Address(root, `m/49'/0'/0'/1/${i}`), path: `m/49'/0'/0'/1/${i}`, child: root.derivePath(`m/49'/0'/0'/1/${i}`) });

        addresses.bip44.receive.push({ address: generateAddress(root, `m/44'/0'/0'/0/${i}`, bitcoin.payments.p2pkh), path: `m/44'/0'/0'/0/${i}`, child: root.derivePath(`m/44'/0'/0'/0/${i}`) });
        addresses.bip44.change.push({ address: generateAddress(root, `m/44'/0'/0'/1/${i}`, bitcoin.payments.p2pkh), path: `m/44'/0'/0'/1/${i}`, child: root.derivePath(`m/44'/0'/0'/1/${i}`) });
    }

    return addresses;
}

function generateAddress(root, path, paymentFn) {
    const child = root.derivePath(path);
    return paymentFn({ pubkey: child.publicKey, network }).address;
}

function generateP2SH_P2WPKH_Address(root, path) {
    const child = root.derivePath(path);
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
    const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });
    return p2sh.address;
}

function scriptHash(address) {
    const outputScript = bitcoin.address.toOutputScript(address, network);
    const hash = bitcoin.crypto.sha256(outputScript).reverse();
    return hash.toString('hex');
}

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

async function fetchElectrumData(client, item, keyPair) {
    const scripthash = scriptHash(item.address);

    try {
        const [balance, utxos, history] = await Promise.all([
            client.blockchainScripthash_getBalance(scripthash),
            client.blockchainScripthash_listunspent(scripthash),
            client.blockchainScripthash_getHistory(scripthash)
        ]);

        const wif = keyPair ? keyPair.toWIF() : item.child.toWIF();

        return {
            address: item.address,
            wif,
            path: item.path,
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
            utxos
        };
    } catch (e) {
        console.error(`Failed to fetch data for address ${item.address}: ${e.message}`);
        throw new Error(`Failed to fetch data for address ${item.address}`);
    }
}

module.exports = async (req, res) => {
    const { key } = req.query;

    if (!key) {
        return res.status(400).json({ error: 'Key parameter is required' });
    }

    try {
        let mnemonic;
        const client = await connectToElectrumServer();

        if (isValidMnemonic(key)) {
            mnemonic = key;
        } else if (isValidWIF(key)) {
            const keyPair = bitcoin.ECPair.fromWIF(key, network);
            const addresses = {
                bip44: { address: bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network }).address, path: "m/44'/0'/0'/0/0" },
                bip49: { address: bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network }), network }).address, path: "m/49'/0'/0'/0/0" },
                bip84: { address: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network }).address, path: "m/84'/0'/0'/0/0" }
            };

            const results = await Promise.all(Object.keys(addresses).map(async (type) => {
                const addressData = await fetchElectrumData(client, addresses[type], keyPair);
                return addressData;
            }));

            const foundAddress = results.find(result => result.balance.total > 0 || result.transactions.total > 0);

            await client.close();

            if (foundAddress) {
                return res.json({ Address: foundAddress });
            } else {
                return res.json({ isFoundAddresses: false });
            }
        } else {
            mnemonic = bip39.generateMnemonic();
        }

        const addresses = generateAddressesFromMnemonic(mnemonic);
        const pubKeys = generatePubKeys(mnemonic);

        const results = {
            bip44: { usedAddresses: [], freshReceiveAddress: {}, freshChangeAddress: {}, totalBalance: 0 },
            bip49: { usedAddresses: [], freshReceiveAddress: {}, freshChangeAddress: {}, totalBalance: 0 },
            bip84: { usedAddresses: [], freshReceiveAddress: {}, freshChangeAddress: {}, totalBalance: 0 },
            key: mnemonic,
            pubKeys
        };

        await Promise.all(['bip44', 'bip49', 'bip84'].map(async (type) => {
            const receiveAddresses = addresses[type].receive;
            const changeAddresses = addresses[type].change;

            try {
                const receiveResults = await Promise.all(receiveAddresses.map((item) => fetchElectrumData(client, item)));
                const changeResults = await Promise.all(changeAddresses.map((item) => fetchElectrumData(client, item)));

                results[type].usedAddresses = receiveResults.concat(changeResults).filter(result => result.transactions.total > 0 || result.balance.total > 0);
                results[type].totalBalance = results[type].usedAddresses.reduce((acc, result) => acc + result.balance.total, 0);

                results[type].freshReceiveAddress = receiveResults[0];
                results[type].freshChangeAddress = changeResults[0];
            } catch (e) {
                console.error(`Error processing ${type}: ${e.message}`);
            }
        }));

        await client.close();

        return res.json(results);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
