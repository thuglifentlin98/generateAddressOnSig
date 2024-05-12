const bitcoin = require('bitcoinjs-lib');

function generateAddressesFromWIF(wif) {
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

    return {
        P2PKH: p2pkhAddress,
        P2SH_P2WPKH: p2shAddress,
        P2WPKH: p2wpkhAddress,
        key: wif  // Include the WIF in the output
    };
}

module.exports = { generateAddressesFromWIF };
