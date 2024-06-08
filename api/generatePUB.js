const fs = require('fs');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const b58 = require('bs58check');

function convertXpubToYpub(xpub) {
    let data = b58.decode(xpub);
    data = Buffer.from(data);
    let prefix = Buffer.from([0x04, 0x9d, 0x7c, 0xb2]);
    data = Buffer.concat([prefix, data.slice(4)]);
    return b58.encode(data);
}

function convertXpubToZpub(xpub) {
    let data = b58.decode(xpub);
    data = Buffer.from(data);
    let prefix = Buffer.from([0x04, 0xb2, 0x47, 0x46]);
    data = Buffer.concat([prefix, data.slice(4)]);
    return b58.encode(data);
}

function generatePubKeys(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        console.error("Invalid mnemonic.");
        return null;
    }
    
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, bitcoin.networks.bitcoin);
    const nodeLegacy = root.derivePath("m/44'/0'/0'");
    const xpub = nodeLegacy.neutered().toBase58();
    const nodeSegwit = root.derivePath("m/49'/0'/0'");
    const ypub = convertXpubToYpub(nodeSegwit.neutered().toBase58());
    const nodeNativeSegwit = root.derivePath("m/84'/0'/0'");
    const zpub = convertXpubToZpub(nodeNativeSegwit.neutered().toBase58());

    return { mnemonic, xpub, ypub, zpub };
}

module.exports = generatePubKeys;
