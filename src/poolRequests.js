;(function () {
  'use strict'

  var async = require('async')

  var constants = require('./constants')
  var logger = require('./logger')
  var database = require('./database')
  var pluck = require('lodash-node/compat/collection/pluck')
  var PoolRequestsDB = database.PoolRequestsDB
  var PodsDB = database.PodsDB
  var utils = require('./utils')
  var VideosDB = database.VideosDB

  var poolRequests = {}

  // ----------- Private -----------
  var timer = null

  function removePoolRequestsFromDB (ids) {
    PoolRequestsDB.remove({ _id: { $in: ids } }, function (err) {
      if (err) {
        logger.error('Cannot remove requests from the pool requests database.', { error: err })
        return
      }

      logger.info('Pool requests flushed.')
    })
  }

  function makePoolRequests () {
    logger.info('Making pool requests to friends.')

    PoolRequestsDB.find({}, { _id: 1, type: 1, request: 1 }, function (err, pool_requests) {
      if (err) throw err

      if (pool_requests.length === 0) return

      var requests = {
        add: {
          ids: [],
          requests: []
        },
        remove: {
          ids: [],
          requests: []
        }
      }

      async.each(pool_requests, function (pool_request, callback_each) {
        if (pool_request.type === 'add') {
          requests.add.requests.push(pool_request.request)
          requests.add.ids.push(pool_request._id)
        } else if (pool_request.type === 'remove') {
          requests.remove.requests.push(pool_request.request)
          requests.remove.ids.push(pool_request._id)
        } else {
          throw new Error('Unkown pool request type.')
        }

        callback_each()
      }, function () {
        // Send the add requests
        if (requests.add.requests.length !== 0) {
          makePoolRequest('add', requests.add.requests, function (err) {
            if (err) logger.error('Errors when sent add pool requests.', { error: err })

            removePoolRequestsFromDB(requests.add.ids)
          })
        }

        // Send the remove requests
        if (requests.remove.requests.length !== 0) {
          makePoolRequest('remove', requests.remove.requests, function (err) {
            if (err) logger.error('Errors when sent remove pool requests.', { error: err })

            removePoolRequestsFromDB(requests.remove.ids)
          })
        }
      })
    })
  }

  function updatePodsScore (good_pods, bad_pods) {
    logger.info('Updating %d good pods and %d bad pods scores.', good_pods.length, bad_pods.length)

    PodsDB.update({ _id: { $in: good_pods } }, { $inc: { score: constants.PODS_SCORE.BONUS } }, { multi: true }).exec()
    PodsDB.update({ _id: { $in: bad_pods } }, { $inc: { score: constants.PODS_SCORE.MALUS } }, { multi: true }, function (err) {
      if (err) throw err
      removeBadPods()
    })
  }

  function removeBadPods () {
    PodsDB.find({ score: 0 }, { _id: 1, url: 1 }, function (err, pods) {
      if (err) throw err

      if (pods.length === 0) return

      var urls = pluck(pods, 'url')
      var ids = pluck(pods, '_id')

      VideosDB.remove({ podUrl: { $in: urls } }, function (err, r) {
        if (err) logger.error('Cannot remove videos from a pod that we removing.', { error: err })
        var videos_removed = r.result.n
        logger.info('Removed %d videos.', videos_removed)

        PodsDB.remove({ _id: { $in: ids } }, function (err, r) {
          if (err) logger.error('Cannot remove bad pods.', { error: err })

          var pods_removed = r.result.n
          logger.info('Removed %d pods.', pods_removed)
        })
      })
    })
  }

  function makePoolRequest (type, requests, callback) {
    if (!callback) callback = function () {}

    PodsDB.find({}, { _id: 1, url: 1, publicKey: 1 }).exec(function (err, pods) {
      if (err) throw err

      var params = {
        encrypt: true,
        sign: true,
        method: 'POST',
        path: null,
        data: requests
      }

      if (type === 'add') {
        params.path = '/api/' + constants.API_VERSION + '/remotevideos/add'
      } else if (type === 'remove') {
        params.path = '/api/' + constants.API_VERSION + '/remotevideos/remove'
      } else {
        throw new Error('Unkown pool request type.')
      }

      var bad_pods = []
      var good_pods = []

      utils.makeMultipleRetryRequest(params, pods, callbackEachPodFinished, callbackAllPodsFinished)

      function callbackEachPodFinished (err, response, body, url, pod, callback_each_pod_finished) {
        if (err || (response.statusCode !== 200 && response.statusCode !== 204)) {
          bad_pods.push(pod._id)
          logger.error('Error sending secure request to %s pod.', url, { error: err || new Error('Status code not 20x') })
        } else {
          good_pods.push(pod._id)
        }

        return callback_each_pod_finished()
      }

      function callbackAllPodsFinished (err) {
        if (err) return callback(err)

        updatePodsScore(good_pods, bad_pods)
        callback(null)
      }
    })
  }

  // ----------- Public -----------
  poolRequests.activate = function () {
    logger.info('Pool requests activated.')
    timer = setInterval(makePoolRequests, constants.INTERVAL)
  }

  poolRequests.addToPoolRequests = function (id, type, request) {
    logger.debug('Add request to the pool requests.', { id: id, type: type, request: request })

    PoolRequestsDB.findOne({ id: id }, function (err, entity) {
      if (err) logger.error(err)

      if (entity) {
        if (entity.type === type) {
          logger.error(new Error('Cannot insert two same requests.'))
          return
        }

        // Remove the request of the other type
        PoolRequestsDB.remove({ id: id }, function (err) {
          if (err) logger.error(err)
        })
      } else {
        PoolRequestsDB.create({ id: id, type: type, request: request }, function (err) {
          if (err) logger.error(err)
        })
      }
    })
  }

  poolRequests.deactivate = function () {
    logger.info('Pool requests deactivated.')
    clearInterval(timer)
  }

  poolRequests.forceSend = function () {
    logger.info('Force pool requests sending.')
    makePoolRequests()
  }

  module.exports = poolRequests
})()
