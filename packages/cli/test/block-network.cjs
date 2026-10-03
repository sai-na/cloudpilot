// Preloaded by the replay tests: any attempt to open a socket fails the run.
const net = require("node:net");
net.Socket.prototype.connect = function () {
  throw new Error("network blocked by test: a replay tried to open a connection");
};
