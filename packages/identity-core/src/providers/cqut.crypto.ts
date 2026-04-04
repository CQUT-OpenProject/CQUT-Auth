import { constants, publicEncrypt } from "node:crypto";

const PUBLIC_KEY =
`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDACwPDxYycdCiNeblZa9LjvDzb
iZU1vc9gKRcG/pGjZ/DJkI4HmoUE2r/o6SfB5az3s+H5JDzmOMVQ63hD7LZQGR4k
3iYWnCg3UpQZkZEtFtXBXsQHjKVJqCiEtK+gtxz4WnriDjf+e/CxJ7OD03e7sy5N
Y/akVmYNtghKZzz6jwIDAQAB
-----END PUBLIC KEY-----`;

function encryptChunk(chunk: string): string {
  return publicEncrypt(
    {
      key: PUBLIC_KEY,
      padding: constants.RSA_PKCS1_PADDING
    },
    Buffer.from(chunk, "utf8")
  ).toString("base64");
}

export function getSecretParam(password: string): string {
  if (!password.trim()) {
    return "";
  }

  const segments: string[] = [];
  let index = 0;

  for (let i = 0; i < password.length + 1; i += 1) {
    if ((i + 1) % 30 === 0) {
      segments.push(encryptChunk(password.slice(index, i)));
      index = i;
    }
  }

  if (index !== password.length) {
    segments.push(encryptChunk(password.slice(index)));
  }

  return encodeURIComponent(JSON.stringify(segments));
}
