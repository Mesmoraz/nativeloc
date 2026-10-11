// Network modules (dns, net, http, https, readline) for the demo: reading other websites needs a real server.
const offline = () => {
  throw new Error("The online demo can't read other websites. Run NativeLoc locally to try this.");
};

export const lookup = offline;
export const isIP = (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(':') ? 6 : 0);
export class BlockList {
  addSubnet() {}
  addAddress() {}
  addRange() {}
  check() {
    return false;
  }
}
export const request = offline;
export const get = offline;
export const createInterface = offline;
export const promises = { lookup };
export default { lookup, isIP, BlockList, request, get, createInterface, promises };
