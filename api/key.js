const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');

async function generateAddressesFromWIF(wif) {
    const network = bitcoin.networks.bitcoin;
    let keyPair;

    try {
        keyPair = bitcoin.ECPair.fromWIF(wif, network);
    } catch (error) {
        return { error: "Invalid WIF provided." };
    }

    const { address: p2pkhAddress } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
    const { address: p2shAddress } = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network })
    });
    const { address: p2wpkhAddress } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });

    // Fetch balances for each address
    const addresses = {
        P2PKH: { address: p2pkhAddress },
        P2SH_P2WPKH: { address: p2shAddress },
        P2WPKH: { address: p2wpkhAddress }
    };

    const electrumClient = new ElectrumClient(51002, 'fulcrum.not.fyi', 'ssl');
    try {
        await electrumClient.connect();
        for (const key in addresses) {
            if (addresses.hasOwnProperty(key)) {
                const balanceData = await getAddressBalance(addresses[key].address, network, electrumClient);
                addresses[key] = { ...addresses[key], balance: balanceData.balance, transactions: balanceData.transactions };
            }
        }
    } catch (error) {
        return { error: "Failed to connect or fetch data from Electrum server." };
    } finally {
        electrumClient.close();
    }

    return {
        Addresses: addresses,
        key: wif  // Include the WIF in the output
    };
}

async function getAddressBalance(address, network, electrumClient) {
    let scriptHash = bitcoin.crypto.sha256(Buffer.from(bitcoin.address.toOutputScript(address, network))).reverse().toString('hex');

    // Fetch history and balance concurrently
    const [history, balance] = await Promise.all([
        electrumClient.blockchainScripthash_getHistory(scriptHash),
        electrumClient.blockchainScripthash_getBalance(scriptHash)
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
        }
    };
}

module.exports = { generateAddressesFromWIF };
