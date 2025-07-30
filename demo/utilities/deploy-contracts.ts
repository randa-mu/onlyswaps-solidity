import { ethers } from "ethers";
import {
  Router__factory,
  ERC20Token__factory,
  BN254SignatureScheme__factory
} from "../../typechain-types";

export async function deployContracts(srcSigner: ethers.Signer, dstSigner: ethers.Signer, pubKeyPoint: any) {
  const ERC20Src = await new ERC20Token__factory(srcSigner).deploy("RUSD", "RUSD", 18, await srcSigner.getAddress());
  const ERC20Dst = await new ERC20Token__factory(dstSigner).deploy("RUSD", "RUSD", 18, await dstSigner.getAddress());

  const BN254SigSrc = await new BN254SignatureScheme__factory(srcSigner).deploy(
    [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
    [pubKeyPoint.y.c0, pubKeyPoint.y.c1]
  );

  const BN254SigDst = await new BN254SignatureScheme__factory(dstSigner).deploy(
    [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
    [pubKeyPoint.y.c0, pubKeyPoint.y.c1]
  );

  const RouterSrc = await new Router__factory(srcSigner).deploy(
    await srcSigner.getAddress(),
    await BN254SigSrc.getAddress()
  );

  const RouterDst = await new Router__factory(dstSigner).deploy(
    await dstSigner.getAddress(),
    await BN254SigDst.getAddress()
  );

  return {
    ERC20Src, ERC20Dst,
    BN254SigSrc, BN254SigDst,
    RouterSrc, RouterDst
  };
}
