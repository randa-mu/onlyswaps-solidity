import { EventFragment, Interface, Result, TransactionReceipt } from "ethers";

// Returns the first instance of an event log from a transaction receipt that matches the address provided
export function extractSingleLog<T extends Interface, E extends EventFragment>(
    iface: T,
    receipt: TransactionReceipt,
    contractAddress: string,
    event: E,
): Result {
    const events = extractLogs(iface, receipt, contractAddress, event);
    if (events.length === 0) {
        throw Error(`contract at ${contractAddress} didn't emit the ${event.name} event`);
    }
    return events[0];
}

function extractLogs<T extends Interface, E extends EventFragment>(
    iface: T,
    receipt: TransactionReceipt,
    contractAddress: string,
    event: E,
): Array<Result> {
    return receipt.logs
        .filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase())
        .map((log) => iface.decodeEventLog(event, log.data, log.topics));
}
