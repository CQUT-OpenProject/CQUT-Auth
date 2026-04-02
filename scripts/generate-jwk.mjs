import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

console.log("# JWT_PRIVATE_KEY");
console.log(privateKey);
console.log("# JWT_PUBLIC_KEY");
console.log(publicKey);

