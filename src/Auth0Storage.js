function Auth0Storage(storage, limit) {
  if (!storage) {
    throw new Error('storage is required');
  }

  this.limit = (typeof limit === 'undefined') ? 400 : limit;
  this.storage = storage;
}

Auth0Storage.prototype.getCheckpoint = function (startFrom) {
  return this.storage.read()
    .then((data) => {
      //TODO: check is startForm date or checkpointId. if date - convert it to checkpointId somehow
      return typeof data === 'undefined' ? startFrom || null : data.checkpointId || startFrom || null;
    });
};

Auth0Storage.prototype.done = function (status, checkpoint) {
  return this.storage.read()
    .then((data) => {
      const storageSize = Buffer.byteLength(JSON.stringify(data), 'utf8');

      if (!data.logs) {
        data.logs = [];
      }

      if (storageSize >= this.limit * 1024 && data.logs && data.logs.length) {
        data.logs.splice(0, 5);
      }

      status.checkpoint = checkpoint;
      data.logs.push(status);
      data.checkpointId = checkpoint;

      return this.storage.write(data);
    });
};

module.exports = Auth0Storage;
