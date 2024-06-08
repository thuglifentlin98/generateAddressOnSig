const { generateWallet } = require('./hdWallet');
const { generateAddressesFromWIF } = require('./key');
const bip39 = require('bip39');

module.exports = async (req, res) => {
    const { key, start = 0, end = 100 } = req.query;

    try {
        let response;
        if (bip39.validateMnemonic(key)) {
            console.log("Valid mnemonic provided, generating HD Wallet...");
            response = await generateWallet(key, parseInt(start), parseInt(end));
        } else {
            try {
                const addressesResponse = await generateAddressesFromWIF(key);
                if (addressesResponse.error) {
                    throw new Error(addressesResponse.error);
                }
                if (addressesResponse.isFoundAddresses === false) {
                    response = { isFoundAddresses: false };
                } else {
                    response = { Address: addressesResponse.Address };
                }
            } catch (error) {
                console.log("Invalid key, generating a new HD Wallet...");
                const newMnemonic = bip39.generateMnemonic();
                response = await generateWallet(newMnemonic, parseInt(start), parseInt(end));
                response.Key = newMnemonic;
            }
        }
        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ error: error.message || "An error occurred" });
    }
};
