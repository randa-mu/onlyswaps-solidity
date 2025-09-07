import { ethers } from "ethers";
import {
  Router__factory,
  ERC20Token__factory,
  UUPSProxy__factory,
  BLSBN254SignatureScheme__factory
} from "../../typechain-types";

export async function deployContracts(srcSigner: ethers.Signer, dstSigner: ethers.Signer, pubKeyPoint: any) {
  const VERIFICATION_FEE_BPS = 500; // 5% fee

  const ERC20Src = await new ERC20Token__factory(srcSigner).deploy("RUSD", "RUSD", 18);
  const ERC20Dst = await new ERC20Token__factory(dstSigner).deploy("RUSD", "RUSD", 18);

  // Deploy BN254 signature schemes with swapped G2 point coordinates
  const swapType = "swap-v1";
  const upgradeType = "upgrade-v1";

  const BN254SigAdminSrc = await new BLSBN254SignatureScheme__factory(srcSigner).deploy(
    [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
    [pubKeyPoint.y.c0, pubKeyPoint.y.c1],
    swapType
  );
  const BN254SigUpgradeSrc = await new BLSBN254SignatureScheme__factory(srcSigner).deploy(
    [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
    [pubKeyPoint.y.c0, pubKeyPoint.y.c1],
    upgradeType
  );
  
  const BN254SigAdminDst = await new BLSBN254SignatureScheme__factory(dstSigner).deploy(
    [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
    [pubKeyPoint.y.c0, pubKeyPoint.y.c1],
    swapType
  );
  const BN254SigUpgradeDst = await new BLSBN254SignatureScheme__factory(dstSigner).deploy(
    [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
    [pubKeyPoint.y.c0, pubKeyPoint.y.c1],
    upgradeType
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
      await BN254SigAdminSrc.getAddress(),
      await BN254SigUpgradeSrc.getAddress(),
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
      await BN254SigAdminDst.getAddress(),
      await BN254SigUpgradeDst.getAddress(),
      VERIFICATION_FEE_BPS
    ])
  );
  await routerProxyDst.waitForDeployment();

  // Attach Router interfaces to proxy addresses
  const RouterSrc = Router__factory.connect(await routerProxySrc.getAddress(), srcSigner);
  const RouterDst = Router__factory.connect(await routerProxyDst.getAddress(), dstSigner);

  return {
    ERC20Src, ERC20Dst,
    BN254SigAdminSrc, BN254SigUpgradeSrc,
    BN254SigAdminDst, BN254SigUpgradeDst,
    RouterSrc, RouterDst
  };
}
