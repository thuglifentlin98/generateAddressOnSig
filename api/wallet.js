const { generateWallet } = require('./hdWallet');
const { generateAddressesFromWIF } = require('./key');
const bip39 = require('bip39');

module.exports = async (req, res) => {
    const { key } = req.query; // Assume key is passed as a query parameter

    try {
        let response;
        if (bip39.validateMnemonic(key)) {
            console.log("Valid mnemonic provided, generating HD Wallet...");
            response = await generateWallet(key);
        } else {
            try {
                const addresses = await generateAddressesFromWIF(key); // Await the function call
                if (addresses.error) {
                    throw new Error(addresses.error);
                }
                response = { Addresses: addresses.Addresses, Key: key }; // Correctly format the response
            } catch (error) {
                console.log("Invalid key, generating a new HD Wallet...");
                const newMnemonic = bip39.generateMnemonic();
                response = await generateWallet(newMnemonic);
                response.Key = newMnemonic; // Include the new mnemonic
            }
        }
        res.status(200).json(response);
    } catch (error) {
        console.error("An error occurred:", error);
        res.status(500).json({ error: error.message || "An error occurred" });
    }
};
