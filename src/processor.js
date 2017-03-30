const _ = require('lodash');
const tools = require('auth0-extension-tools');

const logTypes = require('./logTypes');
const LogsApiStream = require('./stream');
const StorageProvider = require('./storage');

function LogsProcessor(storageContext, options) {
  if (options === null || options === undefined) {
    throw new tools.ArgumentError('Must provide an options object');
  }

  this.storage = new StorageProvider(storageContext);
  this.options = _.assign({ }, options, {
    batchSize: 100,
    maxRetries: 5,
    maxRunTimeSeconds: 20
  });
}

LogsProcessor.prototype.hasTimeLeft = function(start) {
  const now = new Date().getTime();
  const limit = this.options.maxRunTimeSeconds;
  return (start + limit) * 1000 >= now;
};

LogsProcessor.prototype.getLogFilter = function(options) {
  var types = options.logTypes || [];
  if (options.logLevel) {
    types = types.concat(
      _.keys(
        _.filter(logTypes, function(type) {
          return type.level >= options.logLevel;
        })
      )
    );
  }

  return _.uniq(types);
};

LogsProcessor.prototype.createStream = function(options) {
  const self = this;
  return self.storage
    .getCheckpoint(options.startFrom)
    .then(function(startCheckpoint) {
      return new LogsApiStream(self.storage, {
        checkpointId: startCheckpoint,
        types: self.getLogFilter(options),
        domain: options.domain,
        clientId: options.clientId,
        clientSecret: options.clientSecret
      });
    });
};

LogsProcessor.prototype.run = function(handler) {
  const self = this;
  return new Promise((resolve, reject) => {
    const start = new Date().getTime();
    var retries = 0;
    var lastLogDate = 0;
    var logsBatch = [];
    const storage = self.storage;
    const batchSize = self.options.batchSize;
    const maxRetries = self.options.maxRetries;

    // Stop the run because it failed.
    const runFailed = function(error, status, checkpoint) {
      status.error = error;

      storage
        .done(status, checkpoint)
        .then(function() {
          return reject(error);
        })
        .catch(reject);
    };

    // The run ended successfully.
    const runSuccess = function(status, checkpoint) {
      if (status.logsProcessed > 0) {
        const week = 604800000;
        const currentDate = new Date().getTime();
        const timeDiff = currentDate - lastLogDate;

        if (timeDiff >= week) {
          status.warning = 'Logs are outdated more than for week. Last processed log has date is ' +
            new Date(lastLogDate);
        }

        return storage
          .done(status, checkpoint)
          .then(function() {
            return resolve({ status: status, checkpoint: checkpoint });
          })
          .catch(reject);
      }

      return resolve({ status: status, checkpoint: checkpoint });
    };

    // Figure out how big we want the batch of logs to be.
    const getNextLimit = function() {
      var limit = batchSize;
      limit -= logsBatch.length;

      if (limit > 100) {
        limit = 100;
      }
      return limit;
    };

    // Retry the process if it failed.
    const retryProcess = function(err, stream, handleError) {
      if (!self.hasTimeLeft(start)) {
        return runFailed(err, stream.status, stream.previousCheckpoint);
      }

      if (retries < maxRetries) {
        retries += 1;
        return handler.onLogsReceived(logsBatch, handleError);
      }

      const error = [
        'Skipping logs from ' +
        stream.previousCheckpoint +
        ' to ' +
        stream.lastCheckpoint +
        ' after ' +
        maxRetries +
        ' retries.',
        err
      ];

      // We're giving up.
      return runFailed(error, stream.status, stream.lastCheckpoint);
    };

    self.createStream(self.options)
      .then(function(stream) {
        // Get the first batch.
        stream.next(getNextLimit());

        // Process batch of logs.
        stream.on('data', function(logs) {
          logsBatch = logsBatch.concat(logs);

          if (logs && logs.length) {
            lastLogDate = new Date(logs[logs.length - 1].date).getTime();
          }

          // TODO: At some point, even if the batch is too small, we need to ship the logs.
          if (logsBatch.length < batchSize) {
            return stream.next(getNextLimit());
          }

          const processComplete = function(err) {
            if (err) {
              return retryProcess(err, stream, processComplete);
            }

            logsBatch = [];

            if (!self.hasTimeLeft(start)) {
              return stream.done();
            }

            stream.batchSaved();
            return stream.next(getNextLimit());
          };

          return handler.onLogsReceived(logsBatch, processComplete);
        });

        // We've reached the end of the stream.
        stream.on('end', function() {
          const processComplete = function(err) {
            if (err) {
              return retryProcess(err, stream, processComplete);
            }

            stream.batchSaved();
            return runSuccess(stream.status, stream.lastCheckpoint);
          };
          handler.onLogsReceived(logsBatch, processComplete);
        });

        // An error occured when processing the stream.
        stream.on('error', function(err) {
          runFailed(err, stream.status, stream.previousCheckpoint);
        });
      })
      .catch(reject);
  });
};

module.exports = LogsProcessor;