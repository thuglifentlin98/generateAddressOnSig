const bitcoin = require('bitcoinjs-lib');
const bip39 = require('bip39');
const ElectrumClient = require('electrum-client');

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
        addresses.bip84.receive.push(generateAddress(root, `m/84'/0'/0'/0/${i}`, bitcoin.payments.p2wpkh));
        addresses.bip84.change.push(generateAddress(root, `m/84'/0'/0'/1/${i}`, bitcoin.payments.p2wpkh));

        addresses.bip49.receive.push(generateP2SH_P2WPKH_Address(root, `m/49'/0'/0'/0/${i}`));
        addresses.bip49.change.push(generateP2SH_P2WPKH_Address(root, `m/49'/0'/0'/1/${i}`));

        addresses.bip44.receive.push(generateAddress(root, `m/44'/0'/0'/0/${i}`, bitcoin.payments.p2pkh));
        addresses.bip44.change.push(generateAddress(root, `m/44'/0'/0'/1/${i}`, bitcoin.payments.p2pkh));
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

async function fetchElectrumData(address) {
    const scripthash = scriptHash(address);

    for (const server of electrumServers) {
        const client = new ElectrumClient(server.port, server.host, server.protocol);
        await client.connect();

        try {
            const balance = await client.request('blockchain.scripthash.get_balance', scripthash);
            const utxos = await client.request('blockchain.scripthash.listunspent', scripthash);
            const history = await client.request('blockchain.scripthash.get_history', scripthash);

            await client.close();

            return {
                address,
                balance,
                utxos,
                historyCount: history.length
            };
        } catch (e) {
            await client.close();
        }
    }

    throw new Error(`Failed to fetch data for address ${address}`);
}

async function main(key) {
    let mnemonic;

    if (isValidMnemonic(key)) {
        mnemonic = key;
    } else if (isValidWIF(key)) {
        const keyPair = bitcoin.ECPair.fromWIF(key, network);
        const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
        console.log(`WIF Address: ${address}`);
        return;
    } else {
        mnemonic = bip39.generateMnemonic();
        console.log(`Generated Mnemonic: ${mnemonic}`);
    }

    const addresses = generateAddressesFromMnemonic(mnemonic);

    for (const type of ['bip84', 'bip49', 'bip44']) {
        console.log(`${type.toUpperCase()} Addresses:`);
        for (const category of ['receive', 'change']) {
            console.log(`  ${category.toUpperCase()}:`);
            for (const address of addresses[type][category]) {
                try {
                    const data = await fetchElectrumData(address);
                    console.log(`    Address: ${data.address}`);
                    console.log(`      Balance: ${JSON.stringify(data.balance)}`);
                    console.log(`      UTXOs: ${JSON.stringify(data.utxos)}`);
                    console.log(`      Transaction History Count: ${data.historyCount}`);
                } catch (e) {
                    console.error(`Failed to fetch data for address ${address}: ${e.message}`);
                }
            }
        }
    }
}

// Provide your key (mnemonic or WIF) here
const key = 'smooth voice purpose uncover agent busy that alone remove exhaust math trial';

main(key).catch(console.error);
