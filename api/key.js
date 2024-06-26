const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');

const electrumServers = [
    { host: 'fulcrum.sethforprivacy.com', port: 50002, protocol: 'ssl' },
    { host: 'mempool.blocktrainer.de', port: 50002, protocol: 'ssl' },
    { host: 'fulcrum.grey.pw', port: 51002, protocol: 'ssl' },
    { host: 'fortress.qtornado.com', port: 50002, protocol: 'ssl' },
    { host: 'electrumx-core.1209k.com', port: 50002, protocol: 'ssl' },
    { host: 'pipedream.fiatfaucet.com', port: 50002, protocol: 'ssl' },
];

const connectToElectrumServer = async () => {
    for (const server of electrumServers) {
        const client = new ElectrumClient(server.port, server.host, server.protocol);
        try {
            await client.connect();
            console.log(`Connected to Electrum server ${server.host}`);
            return client;
        } catch (error) {
            console.error(`Failed to connect to Electrum server ${server.host}:`, error);
        }
    }
    throw new Error('All Electrum servers failed to connect');
};

async function generateAddressesFromWIF(wif) {
    const network = bitcoin.networks.bitcoin;
    let keyPair;

    try {
        keyPair = bitcoin.ECPair.fromWIF(wif, network);
    } catch (error) {
        console.error("Invalid WIF provided:", error);
        return { error: "Invalid WIF provided." };
    }

    const { address: p2pkhAddress } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
    const { address: p2shAddress } = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network })
    });
    const { address: p2wpkhAddress } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });

    console.log("Generated Addresses:", { p2pkhAddress, p2shAddress, p2wpkhAddress });

    const addresses = {
        P2PKH: { address: p2pkhAddress },
        P2SH_P2WPKH: { address: p2shAddress },
        P2WPKH: { address: p2wpkhAddress }
    };

    let client;
    let maxBalanceAddress = null;
    let maxTransactionAddress = null;

    try {
        client = await connectToElectrumServer();
        console.log("Connected to Electrum server.");

        let maxBalance = 0;
        let maxTransactions = 0;

        for (const key in addresses) {
            if (addresses.hasOwnProperty(key)) {
                const balanceData = await getAddressBalance(addresses[key].address, network, client);
                addresses[key] = { ...addresses[key], balance: balanceData.balance, transactions: balanceData.transactions, utxos: balanceData.utxos, key: wif };
                console.log(`Address ${key} Data:`, addresses[key]);

                const totalBalance = balanceData.balance.total;
                const totalTransactions = balanceData.transactions.total;
                console.log(`Total balance for ${key}:`, totalBalance);
                console.log(`Total transactions for ${key}:`, totalTransactions);

                if (totalBalance > maxBalance) {
                    maxBalance = totalBalance;
                    maxBalanceAddress = addresses[key];
                    console.log(`New max balance found in ${key}:`, maxBalance);
                }

                if (totalTransactions > maxTransactions) {
                    maxTransactions = totalTransactions;
                    maxTransactionAddress = addresses[key];
                    console.log(`New max transactions found in ${key}:`, maxTransactions);
                }
            }
        }
    } catch (error) {
        console.error("Failed to connect or fetch data from Electrum server:", error);
        return { error: "Failed to connect or fetch data from Electrum server." };
    } finally {
        if (client) {
            await client.close();
            console.log("Electrum client closed.");
        }
    }

    if (!maxBalanceAddress && !maxTransactionAddress) {
        console.log("No addresses with balance or transactions found.");
        return { isFoundAddresses: false };
    }

    const addressToReturn = maxBalanceAddress || maxTransactionAddress;

    console.log("Returning address with max balance or transactions:", addressToReturn);
    return {
        Address: addressToReturn
    };
}

async function getAddressBalance(address, network, electrumClient) {
    let scriptHash = bitcoin.crypto.sha256(Buffer.from(bitcoin.address.toOutputScript(address, network))).reverse().toString('hex');
    console.log(`Fetching data for script hash: ${scriptHash}`);

    // Fetch history, balance, and UTXOs concurrently
    const [history, balance, utxos] = await Promise.all([
        electrumClient.blockchainScripthash_getHistory(scriptHash),
        electrumClient.blockchainScripthash_getBalance(scriptHash),
        electrumClient.blockchainScripthash_listunspent(scriptHash)
    ]);

    return {
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

module.exports = { generateAddressesFromWIF };
