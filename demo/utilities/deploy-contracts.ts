import { ethers } from "ethers";
import {
  Router__factory,
  ERC20Token__factory,
  UUPSProxy__factory,
  BN254SignatureScheme__factory
} from "../../typechain-types";

export async function deployContracts(srcSigner: ethers.Signer, dstSigner: ethers.Signer, pubKeyPoint: any) {
  const VERIFICATION_FEE_BPS = 500; // 5% fee

  const ERC20Src = await new ERC20Token__factory(srcSigner).deploy("RUSD", "RUSD", 18);
  const ERC20Dst = await new ERC20Token__factory(dstSigner).deploy("RUSD", "RUSD", 18);

  // Deploy BN254 signature schemes with swapped G2 point coordinates
  const BN254SigSrc = await new BN254SignatureScheme__factory(srcSigner).deploy(
    [pubKeyPoint.x.c1, pubKeyPoint.x.c0],
    [pubKeyPoint.y.c1, pubKeyPoint.y.c0]
  );
  const BN254SigDst = await new BN254SignatureScheme__factory(dstSigner).deploy(
    [pubKeyPoint.x.c1, pubKeyPoint.x.c0],
    [pubKeyPoint.y.c1, pubKeyPoint.y.c0]
  );

  // Deploy Router implementations
  const routerImplementationSrc = await new Router__factory(srcSigner).deploy();
  await routerImplementationSrc.waitForDeployment();

  const routerImplementationDst = await new Router__factory(dstSigner).deploy();
  await routerImplementationDst.waitForDeployment();

  // Deploy UUPS proxies for Routers
  const UUPSProxyFactorySrc = new ethers.ContractFactory(
    UUPSProxy__factory.abi,
    UUPSProxy__factory.bytecode,
    srcSigner
  );
  const routerProxySrc = await UUPSProxyFactorySrc.deploy(
    await routerImplementationSrc.getAddress(),
    routerImplementationSrc.interface.encodeFunctionData("initialize", [
      await srcSigner.getAddress(),
      await BN254SigSrc.getAddress(),
      await BN254SigSrc.getAddress(),
      VERIFICATION_FEE_BPS
    ])
  );
  await routerProxySrc.waitForDeployment();

  const UUPSProxyFactoryDst = new ethers.ContractFactory(
    UUPSProxy__factory.abi,
    UUPSProxy__factory.bytecode,
    dstSigner
  );
  const routerProxyDst = await UUPSProxyFactoryDst.deploy(
    await routerImplementationDst.getAddress(),
    routerImplementationDst.interface.encodeFunctionData("initialize", [
      await dstSigner.getAddress(),
      await BN254SigDst.getAddress(),
      await BN254SigDst.getAddress(),
      VERIFICATION_FEE_BPS
    ])
  );
  await routerProxyDst.waitForDeployment();

  // Attach Router interfaces to proxy addresses
  const RouterSrc = Router__factory.connect(await routerProxySrc.getAddress(), srcSigner);
  const RouterDst = Router__factory.connect(await routerProxyDst.getAddress(), dstSigner);

  return {
    ERC20Src, ERC20Dst,
    BN254SigSrc, BN254SigDst,
    RouterSrc, RouterDst
  };
}
