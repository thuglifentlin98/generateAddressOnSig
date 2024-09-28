const { generateWallet } = require('./hdWallet');
const { generateAddressesFromWIF } = require('./key');
const bip39 = require('bip39');

module.exports = async (req, res) => {
    const { key } = req.query;
    const requestBody = req.body;  // Capture the request body

    try {
        let response;
        if (bip39.validateMnemonic(key)) {
            console.log("Valid mnemonic provided, generating HD Wallet...");
            response = await generateWallet(key);
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
                response = await generateWallet(newMnemonic);
                response.Key = newMnemonic;
            }
        }

        // Log request body and response body to Vercel logs
        console.log("Request Body:", requestBody);
        console.log("Response Body:", response);

        res.status(200).json(response);
    } catch (error) {
        console.log("Error:", error.message || "An error occurred");

        // Log request body and error to Vercel logs
        console.log("Request Body:", requestBody);
        console.log("Error Response Body:", { error: error.message || "An error occurred" });

        res.status(500).json({ error: error.message || "An error occurred" });
    }
};
