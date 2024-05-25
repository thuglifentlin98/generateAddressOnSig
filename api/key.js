const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');

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

    const electrumClient = new ElectrumClient(51002, 'fulcrum.not.fyi', 'ssl');
    let maxBalanceAddress = null;

    try {
        await electrumClient.connect();
        console.log("Connected to Electrum server.");

        let maxBalance = 0;
        for (const key in addresses) {
            if (addresses.hasOwnProperty(key)) {
                const balanceData = await getAddressBalance(addresses[key].address, network, electrumClient);
                addresses[key] = { ...addresses[key], balance: balanceData.balance, transactions: balanceData.transactions, utxos: balanceData.utxos };
                console.log(`Address ${key} Data:`, addresses[key]);

                const totalBalance = balanceData.balance.total;
                if (totalBalance > maxBalance) {
                    maxBalance = totalBalance;
                    maxBalanceAddress = addresses[key];
                }
            }
        }
    } catch (error) {
        console.error("Failed to connect or fetch data from Electrum server:", error);
        return { error: "Failed to connect or fetch data from Electrum server." };
    } finally {
        electrumClient.close();
        console.log("Electrum client closed.");
    }

    if (!maxBalanceAddress) {
        return { isFoundAddresses: false };
    }

    return {
        Address: maxBalanceAddress,
        key: wif  // Include the WIF in the output
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
