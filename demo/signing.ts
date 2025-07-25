import { randomBytes } from "@noble/hashes/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";

export function generateBlsKeys() {
  const privKeyBytes = Uint8Array.from(randomBytes(32));
  const pubKeyBytes = bn254.getPublicKeyForShortSignatures(privKeyBytes);
  const pubKeyPoint = bn254.G2.ProjectivePoint.fromHex(pubKeyBytes).toAffine();
  return { privKeyBytes, pubKeyPoint };
}

export function signMessage(messageG1: { x: bigint, y: bigint }, privKey: Uint8Array) {
  const M = bn254.G1.ProjectivePoint.fromAffine(messageG1);
  return bn254.signShortSignature(M, privKey).toAffine();
}
