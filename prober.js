if (process.env['AIRBRAKE_KEY']) {
  var airbrake = require('airbrake');
  airbrake = airbrake.createClient(process.env['AIRBRAKE_KEY']);
  airbrake.handleExceptions();
}


var Http = require('http')
;

var _fetch_endpoints
,   _probe_routers
,   _probe_passers
,   _probe_backends
,   _report_results
;

var busy
,   agent
,   alice_host
,   alice_port
;

alice_host = process.env['ALICE_HOST'] || 'localhost';
alice_port = process.env['ALICE_PORT'] || '5000';
alice_port = parseInt(alice_port, 10);

_fetch_endpoints = function(){
  if (busy) {
    console.log('Still busy!');
    return;
  }

  busy = true;

  var buffer
  ,   options
  ,   endpoints
  ,   report
  ;

  buffer = "";
  options = {
    host: alice_host,
    port: alice_port,
    path: '/api_v1/endpoints.json'
  };

  Http.get(options, function(res) {
    if (res.statusCode == 200) {
      res.setEncoding('utf8');
      res.on('data', function(chunk){
        buffer += chunk;
      });

      res.on('end', function(){
        endpoints = JSON.parse(buffer);
        report    = { routers: {}, passers: {}, backends: {} };
        _probe_routers(endpoints, report);
      });

      res.on('close', function(e){
        busy = false;
        console.log("Got error: " + e.message);
      });
    } else {
      busy = false;
      console.log("Got error: " + res.statusCode);
    }
  }).on('error', function(e) {
    busy = false;
    console.log("Got error: " + e.message);
  });
};

_probe_routers = function(endpoints, report){
  var cont
  ,   pending = {}
  ;

  cont = function(key){
    if (!pending[key]) { return; }
    delete pending[key];
    if (Object.keys(pending).length == 0) {
      _probe_passers(endpoints, report);
    }
  };

  endpoints['routers'].forEach(function(router){
    var options
    ,   req
    ,   t
    ,   key
    ;

    key = '' + router['host'] + router['port'];
    pending[key] = true;

    options = {
      agent:  agent,
      method: 'HEAD',
      host:   router['host'],
      port:   router['port'],
      path:   '/_alice/probe/router',
      headers: { 'Connection': 'close' }
    };

    req = Http.request(options);
    req.setHeader('Connection', 'close');

    req.on('response', function(res){
      if (res.statusCode == 200) {
        report['routers'][router.id] = true;
      } else {
        report['routers'][router.id] = { 'error': "Returned status: "+res.statusCode };
      }
      clearTimeout(t);
      cont(key);
    });

    t = setTimeout(function(){
      report['routers'][router.id] = { 'error': 'Timeout' };
      cont(key);
    }, 5000);

    req.on('error', function(err){
      report['routers'][router.id] = { 'error': err.message };
      clearTimeout(t);
      cont(key);
    });

    req.end();
  });
};

_probe_passers = function(endpoints, report){
  var cont
  ,   pending = {}
  ;

  cont = function(key){
    if (!pending[key]) { return; }
    delete pending[key];
    if (Object.keys(pending).length == 0) {
      _probe_backends(endpoints, report);
    }
  };

  endpoints['passers'].forEach(function(passer){
    var options
    ,   req
    ,   t
    ,   key
    ;

    key = '' + passer['host'] + passer['port'];
    pending[key] = true;

    options = {
      agent:  agent,
      method: 'HEAD',
      host:   passer['host'],
      port:   passer['port'],
      path:   '/_alice/probe/passer',
      headers: { 'Connection': 'close' }
    };

    req = Http.request(options);
    req.setHeader('Connection', 'close');

    req.on('response', function(res){
      if (res.statusCode == 200) {
        report['passers'][passer.id] = true;
      } else {
        report['passers'][passer.id] = { 'error': "Returned status: "+res.statusCode };
      }
      clearTimeout(t);
      cont(key);
    });

    t = setTimeout(function(){
      report['passers'][passer.id] = { 'error': 'Timeout' };
      cont(key);
    }, 5000);

    req.on('error', function(err){
      report['passers'][passer.id] = { 'error': err.message };
      clearTimeout(t);
      cont(key);
    });

    req.end();
  });
};

_probe_backends = function(endpoints, report){
  var cont
  ,   pending = {}
  ;

  cont = function(key){
    if (!pending[key]) { return; }
    delete pending[key];
    if (Object.keys(pending).length == 0) {
      _report_results(endpoints, report);
    }
  };

  endpoints['backends'].forEach(function(backend){
    var options
    ,   req
    ,   t
    ,   key
    ;

    key = '' + backend['host'] + backend['port'];
    pending[key] = true;

    options = {
      agent:  agent,
      method: 'GET',
      host:   backend['host'],
      path:   '/_alice/probe/backend',
      headers: {
        'X-Pluto-Backend-Port': backend['port'],
        'Connection': 'close'
      }
    };

    endpoints['passers'].forEach(function(passer){
      if (!options.port && report['passers'][''+passer.id] === true && passer.host === backend.host) {
        options.port = passer.port;
      }
    });

    if (!options.port) {
      report['backends'][backend.id] = { 'error': 'No passer for '+backend.host };
      cont(key);
      return;
    }

    req = Http.request(options);
    req.setHeader('Connection', 'close');

    req.on('response', function(res){
      if (res.statusCode != 503) {
        report['backends'][backend.id] = true;
      } else {
        report['backends'][backend.id] = { 'error': "Returned status: "+res.statusCode };
      }
      clearTimeout(t);
      cont(key);
    });

    t = setTimeout(function(){
      report['backends'][backend.id] = { 'error': 'Timeout' };
      cont(key);
    }, 30000);

    req.on('error', function(err){
      report['backends'][backend.id] = { 'error': err.message };
      clearTimeout(t);
      cont(key);
    });

    req.end();
  });
};

_report_results = function(endpoints, report){
  var options
  ,   req
  ,   t
  ,   data
  ;

  data = JSON.stringify(report);

  options = {
    method: 'POST',
    host:   alice_host,
    port:   alice_port,
    path:   '/api_v1/probe_report',
    headers: {
      'Content-Type':   'application/json',
      'Accepts':        'application/json',
      'Content-Length': data.length
    }
  };

  req = Http.request(options);

  req.on('response', function(res){
    busy = false;
  });

  req.on('error', function(err){
    busy = false;
  });

  req.write(data, 'utf8');
  req.end();
};

agent = new Http.Agent();
agent.maxSockets = 100;

setInterval(_fetch_endpoints, 30000);
