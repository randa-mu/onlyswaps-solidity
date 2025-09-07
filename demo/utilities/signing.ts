import { randomBytes } from "@noble/hashes/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { AbiCoder } from "ethers";

export function generateBlsKeys() {
  const privKeyBytes = Uint8Array.from(randomBytes(32));
  const pubKeyBytes = bn254.getPublicKeyForShortSignatures(privKeyBytes);
  const pubKeyPoint = bn254.G2.ProjectivePoint.fromHex(pubKeyBytes).toAffine();
  return { privKeyBytes, pubKeyPoint };
}

export function signMessage(messageAsG1Bytes: string, privKeyBytes: Uint8Array) {
  // Remove "0x" prefix if present
  const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
  // Unmarshall messageAsG1Bytes to a G1 point first
  const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
  // Sign message
  const sigPoint = bn254.signShortSignature(M, privKeyBytes);
  // Serialize signature (x, y) for EVM
  const sigPointToAffine = sigPoint.toAffine();
  return sigPointToAffine;
}

export function encodeSignature(sigAffine: { x: bigint, y: bigint }): string {
  const abi = new AbiCoder();
  return abi.encode(["uint256", "uint256"], [sigAffine.x, sigAffine.y]);
}
