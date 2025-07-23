import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";

function toHexBE(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function pubkeyToSolidity(pubKeyPoint: ReturnType<typeof bn254.G2.ProjectivePoint.prototype.toAffine>) {
  const { x, y } = pubKeyPoint;
  return {
    x: {
      c0: x.c0,
      c1: x.c1,
    },
    y: {
      c0: y.c0,
      c1: y.c1,
    },
  };
}

function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function verifyKeyPair(
  privKeyBytes: Uint8Array,
  pubKeyBytes: Uint8Array
): boolean {
  try {
    const plainText = "hello world";
    const msgBytes = stringToUint8Array(plainText);

    const sig = bn254.signShortSignature(msgBytes, privKeyBytes);
    const verified = bn254.verifyShortSignature(sig, msgBytes, pubKeyBytes);

    return verified;
  } catch (e) {
    console.error("Verification error:", e);
    return false;
  }
}

function verifyKeyPairWithDST(
  privKeyBytes: Uint8Array,
  pubKeyBytes: Uint8Array,
  dst: string
): boolean {
  try {
    const plainText = "hello world";
    const msgBytes = stringToUint8Array(plainText);

    // Hash to G1 point with DST, get x, y coordinates as BigInt array or tuple
    const messageOnG1Curve = bn254.G1.hashToCurve(msgBytes, { DST: dst });
    const messageAsG1Point = messageOnG1Curve.toAffine();
    const M = bn254.G1.ProjectivePoint.fromAffine({
      x: messageAsG1Point.x,
      y: messageAsG1Point.y
    });

    // Sign the G1 ProjectivePoint directly
    const sig = bn254.signShortSignature(M, privKeyBytes);

    // Verify signature using the same message point and pubKey
    const verified = bn254.verifyShortSignature(sig, M, pubKeyBytes);

    return verified;
  } catch (e) {
    console.error("Verification error:", e);
    return false;
  }
}


async function main() {
  // Generate random private key as Uint8Array
  const privKeyBytes = Uint8Array.from(randomBytes(32));
  const privKeyHex = toHexBE(privKeyBytes);

  // Derive serialized public key bytes (Uint8Array)
  const pubKeyBytes = bn254.getPublicKeyForShortSignatures(privKeyBytes);

  // Deserialize public key bytes to affine point for coordinate extraction
  const pubKeyPoint = bn254.G2.ProjectivePoint.fromHex(pubKeyBytes).toAffine();

  // Convert public key to Solidity-compatible format
  const pubKeySol = pubkeyToSolidity(pubKeyPoint);

  // Verify key pair correctness
  const isValid = verifyKeyPair(privKeyBytes, pubKeyBytes);
  const isValidWithDST = verifyKeyPairWithDST(privKeyBytes, pubKeyBytes, "dst");

  // Log results
  console.log("Private Key (hex):", privKeyHex);
  console.log("Public Key (Solidity format):", pubKeySol);
  console.log("Key pair matches:", isValid);
  console.log("Key pair matches with DST:", isValidWithDST);
}

if (require.main === module) {
  main();
}

// Usage: npx ts-node utils/generate-bn254-keypair.ts