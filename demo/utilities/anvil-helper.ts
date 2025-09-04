import { spawn, ChildProcess } from "child_process";
import net from "net";

function waitForPort(port: number, host = "127.0.0.1", timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = net.createConnection(port, host, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 100);
        }
      });
    };
    check();
  });
}

export async function launchAnvilPair(): Promise<{ src: ChildProcess; dst: ChildProcess; cleanup: () => void }> {
  const anvilSrc = spawn("anvil", ["--port", "8545", "--chain-id", "31337"], { stdio: "ignore" });
  const anvilDst = spawn("anvil", ["--port", "8546", "--chain-id", "31338"], { stdio: "ignore" });

  await Promise.all([waitForPort(8545), waitForPort(8546)]);
  console.log("Anvil instances ready...");

  const cleanup = () => {
    anvilSrc.kill();
    anvilDst.kill();
    console.log("Anvil instances stopped.");
  };

  return { src: anvilSrc, dst: anvilDst, cleanup };
}
