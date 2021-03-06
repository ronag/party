'use strict'

var level = require('level')
var has = require('has')
var pump = require('pump')
var fs = require('fs')
var net = require('net')
var path = require('path')
var multileveldown = require('multileveldown')

module.exports = function (dir, opts) {
  if (!opts) opts = {}
  if (!has(opts, 'retry')) opts.retry = true

  var sockPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\level-party\\' + path.resolve(dir)
    : path.join(dir, 'level-party.sock')

  var client = multileveldown.client(opts)

  client.open(tryConnect)

  function tryConnect () {
    if (!client.isOpen()) return

    var socket = net.connect(sockPath)
    var connected = false

    socket.on('connect', function () {
      connected = true
    })

    // we pass socket as the ref option so we dont hang the event loop
    pump(socket, client.createRpcStream({ ref: socket }), socket, function () {
      if (!client.isOpen()) return

      var db = level(dir, opts, onopen)

      function onopen (err) {
        if (err) {
          if (connected) return tryConnect()
          return setTimeout(tryConnect, 100)
        }

        fs.unlink(sockPath, function (err) {
          if (err && err.code !== 'ENOENT') return db.emit('error', err)
          if (!client.isOpen()) return

          var sockets = []
          var server = net.createServer(function (sock) {
            if (sock.unref) sock.unref()
            sockets.push(sock)
            pump(sock, multileveldown.server(db), sock, function () {
              sockets.splice(sockets.indexOf(sock), 1)
            })
          })

          client.close = shutdown
          client.emit('leader')
          client.forward(db)

          server.listen(sockPath, onlistening)

          function shutdown (cb) {
            sockets.forEach(function (sock) {
              sock.destroy()
            })
            server.close(function () {
              db.close(cb)
            })
          }

          function onlistening () {
            if (server.unref) server.unref()
            if (client.isFlushed()) return

            var sock = net.connect(sockPath)
            pump(sock, client.createRpcStream(), sock)
            client.once('flush', function () {
              sock.destroy()
            })
          }
        })
      }
    })
  };

  return client
}
