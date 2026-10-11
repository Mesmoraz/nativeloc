// Outside the demo build, 'demo-server' resolves here; nothing loads it.
const missing = () => {
  throw new Error('The in-browser server only exists in the demo build.');
};
export const buildApp = missing;
export const setMailer = missing;
