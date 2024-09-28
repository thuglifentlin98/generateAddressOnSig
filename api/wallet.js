const { generateWallet } = require('./hdWallet');
const { generateAddressesFromWIF } = require('./key');
const bip39 = require('bip39');
const bs58 = require('bs58');  // Required for base58 (WIF) validation

// Function to validate if a string is a valid base58-encoded WIF
function isValidWIF(wifString) {
    try {
        bs58.decode(wifString);
        return true;
    } catch (error) {
        return false;
    }
}

module.exports = async (req, res) => {
    const { key } = req.query;  // Get 'key' parameter from query
    const requestBody = req.body;  // Capture the request body

    try {
        let response;

        // If 'key' is not set or empty, generate a new wallet
        if (!key || key.trim() === '') {
            console.log("No key provided, generating a new wallet...");
            const newMnemonic = bip39.generateMnemonic();
            response = await generateWallet(newMnemonic);
            response.Key = newMnemonic;
        } 
        // If 'key' is set, check if it's a valid mnemonic
        else if (bip39.validateMnemonic(key)) {
            console.log("Valid mnemonic provided, generating HD Wallet...");
            response = await generateWallet(key);
        } 
        // If it's not a valid mnemonic, check if it's a valid WIF
        else {
            if (isValidWIF(key)) {
                try {
                    const addressesResponse = await generateAddressesFromWIF(key);
                    if (addressesResponse.error) {
                        throw new Error(addressesResponse.error);
                    }
                    response = addressesResponse.isFoundAddresses === false 
                        ? { isFoundAddresses: false } 
                        : { Address: addressesResponse.Address };
                } catch (error) {
                    throw new Error("Invalid WIF provided");
                }
            } 
            // If it's neither a valid WIF nor a valid mnemonic, generate a new mnemonic
            else {
                console.log("Invalid key, generating a new HD Wallet...");
                const newMnemonic = bip39.generateMnemonic();
                response = await generateWallet(newMnemonic);
                response.Key = newMnemonic;
            }
        }

        // Log request and response to Vercel logs
        console.log("Request Body:", requestBody);
        console.log("Response Body:", response);

        // Send the response to the client
        res.status(200).json(response);

    } catch (error) {
        console.log("Error:", error.message || "An error occurred");

        // Log request and error response to Vercel logs
        console.log("Request Body:", requestBody);
        console.log("Error Response Body:", { error: error.message || "An error occurred" });

        res.status(500).json({ error: error.message || "An error occurred" });
    }
};
