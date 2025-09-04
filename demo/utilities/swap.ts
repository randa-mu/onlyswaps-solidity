import { parseEther } from "ethers";
import { ERC20Token, Router } from "../../typechain-types";

export async function executeSwap(
  ERC20Src: ERC20Token,
  ERC20Dst: ERC20Token,
  RouterSrc: Router,
  recipient: string,
  DST_CHAIN_ID: number,
  signer: any
) {
  const userAddr = await signer.getAddress();
  const amount = parseEther("10");
  const fee = parseEther("1");
  const total = amount + fee;

  await ERC20Src.mint(userAddr, total);
  await ERC20Src.approve(RouterSrc.getAddress(), total);

  const tx = await RouterSrc.requestCrossChainSwap(
    await ERC20Src.getAddress(),
    await ERC20Dst.getAddress(),
    amount,
    fee,
    DST_CHAIN_ID,
    recipient
  );
  
  return { tx, amount, fee };
}
