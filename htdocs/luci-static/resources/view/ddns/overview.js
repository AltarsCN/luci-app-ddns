'use strict';
'require ui';
'require view';
'require dom';
'require poll';
'require uci';
'require network';
'require rpc';
'require fs';
'require form';
'require tools.widgets as widgets';

return view.extend({

	NextUpdateStrings : {
		'Verify' : _("Verify"),
		'Run once' : _("Run once"),
		'Disabled' : _("Disabled"),
		'Stopped' : _("Stopped")
	},

	time_res : {
		seconds : 1,
		minutes : 60,
		hours : 3600,
	},

	callGetLogServices: rpc.declare({
		object: 'luci.ddns',
		method: 'get_services_log',
		params: [ 'name', 'action' ],
		expect: { result: false }
	}),

	callDDnsGetStatus: rpc.declare({
		object: 'luci.ddns',
		method: 'get_ddns_state',
		expect: {  }
	}),

	callDDnsGetEnv: rpc.declare({
		object: 'luci.ddns',
		method: 'get_env',
		expect: {  }
	}),

	callDDnsGetServicesStatus: rpc.declare({
		object: 'luci.ddns',
		method: 'get_services_status',
		expect: {  }
	}),

	neighborCache: {},

	callListNeighbors: function(opts) {
		var args = [];

		if (!opts)
			return Promise.resolve(null);

		if (opts.interface)
			args.push('-i', opts.interface);
		else if (opts.network)
			args.push('-n', opts.network);
		else
			return Promise.resolve(null);

		args.push('--', 'list_neighbors');

		return fs.exec('/usr/lib/ddns/dynamic_dns_lucihelper.sh', args).then(function(res) {
			if (!res || res.code !== 0)
				return null;

			var stdout = res.stdout ? res.stdout.trim() : '';
			if (!stdout)
				return null;

			try {
				return JSON.parse(stdout);
			}
			catch (err) {
				return null;
			}
		});
	},

	normalizeNeighborPayload: function(response, origin) {
		var results = [];
		var via = origin && (origin.interface || (origin.network ? '@' + origin.network : null));
		var map = {};
		var prefixes = [];

		if (!response)
			return results;

		// Extract prefixes
		if (Array.isArray(response.prefixes)) {
			console.log('[DDNS Debug] Raw prefixes from backend:', response.prefixes);
			response.prefixes.forEach(function(p) {
				if (p) {
					var parts = String(p).split('/');
					var addr = parts[0].toLowerCase();
					var len = parseInt(parts[1]) || 64;
					// Normalize prefix - keep first N bits based on length
					// For /64, keep first 4 groups (64 bits)
					var groups = Math.ceil(len / 16);
					var normalized = addr.split(':').slice(0, groups).join(':');
					console.log('[DDNS Debug] Prefix:', p, '-> normalized:', normalized);
					prefixes.push({ raw: p, prefix: normalized, length: len });
				}
			});
		}
		console.log('[DDNS Debug] Final prefixes array:', JSON.stringify(prefixes));

		if (!Array.isArray(response.devices))
			return results;

		// Helper to check if address matches any prefix
		var matchesPrefix = function(addr) {
			if (!addr || prefixes.length === 0) {
				console.log('[DDNS Debug] matchesPrefix: no addr or no prefixes, return false');
				return false;
			}
			var lowerAddr = String(addr).toLowerCase();
			for (var i = 0; i < prefixes.length; i++) {
				var idx = lowerAddr.indexOf(prefixes[i].prefix);
				console.log('[DDNS Debug] matchesPrefix:', lowerAddr, 'vs', prefixes[i].prefix, '-> indexOf:', idx);
				if (idx === 0)
					return true;
			}
			return false;
		};

		// Helper to classify address type
		var classifyAddress = function(addr) {
			if (!addr)
				return { type: 'invalid', priority: 99 };
			var lower = String(addr).toLowerCase();

			// Link-local - skip entirely
			if (lower.indexOf('fe80:') === 0)
				return { type: 'link-local', priority: 99 };

			// ULA (fc00::/7 = fc or fd)
			if (lower.charAt(0) === 'f' && (lower.charAt(1) === 'c' || lower.charAt(1) === 'd'))
				return { type: 'ula', priority: 3, matchesPD: false };

			// GUA - check if matches PD prefix
			var matches = matchesPrefix(addr);
			return { type: 'gua', priority: matches ? 1 : 2, matchesPD: matches };
		};

		response.devices.forEach(function(device) {
			if (!device)
				return;
			var mac = device.mac ? device.mac.toLowerCase() : null;
			if (!mac)
				return;

			var entry = map[mac];
			if (!entry) {
				entry = map[mac] = {
					mac: mac,
					addresses: [],
					addressInfo: [],
					hostname: device.hostname || null,
					via: via || null,
					hasPDMatch: false
				};
			}
			else if (!entry.hostname && device.hostname) {
				entry.hostname = device.hostname;
			}

			if (Array.isArray(device.addresses)) {
				var addressData = [];

				device.addresses.forEach(function(addr) {
					if (!addr)
						return;

					var info = classifyAddress(addr);
					if (info.type === 'link-local' || info.type === 'invalid')
						return;

					addressData.push({
						address: addr,
						type: info.type,
						priority: info.priority,
						matchesPD: info.matchesPD
					});

					if (info.matchesPD)
						entry.hasPDMatch = true;
				});

				// Sort addresses by priority (PD-matching GUA first, then other GUA, then ULA)
				addressData.sort(function(a, b) {
					return a.priority - b.priority;
				});

				addressData.forEach(function(info) {
					if (entry.addresses.indexOf(info.address) === -1) {
						entry.addresses.push(info.address);
						entry.addressInfo.push(info);
					}
				});
			}
		});

		results = Object.values(map).map(L.bind(function(item) {
			item.label = this.formatNeighborLabel(item);
			// Store the best address (first one after sorting)
			item.bestAddress = item.addresses.length > 0 ? item.addresses[0] : null;
			item.bestAddressMatchesPD = item.addressInfo.length > 0 ? item.addressInfo[0].matchesPD : false;
			return item;
		}, this));

		// Sort devices: those with PD-matching addresses first
		results.sort(function(a, b) {
			// Primary: has PD match
			if (a.hasPDMatch !== b.hasPDMatch)
				return a.hasPDMatch ? -1 : 1;
			// Secondary: hostname vs no hostname
			var aName = a.hostname || a.mac;
			var bName = b.hostname || b.mac;
			return aName.localeCompare(bName);
		});

		return results;
	},

	formatNeighborLabel: function(device) {
		var parts = [];
		var hostname = device.hostname || _('Unnamed device');

		parts.push(hostname);
		parts.push(device.mac);

		if (Array.isArray(device.addresses) && device.addresses.length > 0)
			parts.push(device.addresses[0]);

		var label = parts.join(' • ');

		if (device.addresses && device.addresses.length > 1)
			label += ' ' + String.format(_('(+%d more)'), device.addresses.length - 1);

		if (device.via)
			label += ' ' + String.format(_('[via %s]'), device.via);

		return label;
	},

	fetchDeviceChoices: function(section_id, section, options) {
		var opts = options || {};
		var ipInterface = section ? section.formvalue(section_id, 'ip_interface') : null;
		var ipNetwork = section ? section.formvalue(section_id, 'ip_network') : null;
		var args = {};
		var cacheKey;

		if (ipInterface == null)
			ipInterface = uci.get('ddns', section_id, 'ip_interface');
		if (ipNetwork == null)
			ipNetwork = uci.get('ddns', section_id, 'ip_network');

		if (ipInterface)
			ipInterface = String(ipInterface).trim();
		if (ipNetwork)
			ipNetwork = String(ipNetwork).trim();

		if (ipInterface) {
			if (ipInterface.charAt(0) === '@' && ipInterface.length > 1) {
				args.network = ipInterface.substr(1);
				cacheKey = 'network:' + args.network;
			}
			else {
				args.interface = ipInterface;
				cacheKey = 'interface:' + args.interface;
			}
		}
		else if (ipNetwork) {
			args.network = ipNetwork;
			cacheKey = 'network:' + args.network;
		}
		else {
			return Promise.resolve({
				choices: [],
				message: _('Select an interface to scan for IPv6 neighbors.')
			});
		}

		if (opts.force)
			delete this.neighborCache[cacheKey];

		if (this.neighborCache[cacheKey]) {
			return Promise.resolve({
				choices: this.neighborCache[cacheKey],
				source: args,
				fromCache: true
			});
		}

		return this.callListNeighbors(args).then(L.bind(function(response) {
			var normalized = this.normalizeNeighborPayload(response, args);
			this.neighborCache[cacheKey] = normalized;
			return {
				choices: normalized,
				source: args
			};
		}, this)).catch(function() {
			return {
				choices: [],
				error: true,
				message: _('Failed to query IPv6 neighbors.')
			};
		});
	},

	services: {},

	/*
	 * Services list is generated by 3 different sources:
	 * 1. /usr/share/ddns/default contains the service installed by package-manager
	 * 2. /usr/share/ddns/custom contains any service installed by the
	 *    user or the ddns script (for example when services are
	 *    downloaded)
	 * 3. /usr/share/ddns/list contains all the services that can be
	 *    downloaded by using the ddns script ('service on demand' feature)
	 *
	 * (Special services that requires a dedicated package ARE NOT
	 * supported by the 'service on demand' feature)
	 */
	callGenServiceList: function(m, ev) {
		return Promise.all([
			L.resolveDefault(fs.list('/usr/share/ddns/default'), []),
			L.resolveDefault(fs.list('/usr/share/ddns/custom'), []),
			L.resolveDefault(fs.read('/usr/share/ddns/list'), null)
		]).then(L.bind(function (data) {
			var default_service = data[0],
				custom_service = data[1],
				list_service = data[2] && data[2].split("\n") || [],
				_this = this;

			this.services = {};

			default_service.forEach(function (service) {
				_this.services[service.name.replace('.json','')] = true
			});

			custom_service.forEach(function (service) {
				_this.services[service.name.replace('.json','')] = true
			});

			this.services = Object.fromEntries(Object.entries(this.services).sort());

			list_service.forEach(function (service) {
				if (!_this.services[service])
					_this.services[service] = false;
			});
		}, this))
	},

	/*
	* Figure out what the wan interface on the device is.
	* Determine if the physical device exist, or if we should use an alias.
	*/
	callGetWanInterface: function(m, ev) {
		return network.getDevice('wan').then(dev => dev.getName())
			.catch(err => network.getNetwork('wan').then(net => '@' + net.getName()))
			.catch(err => null);
	},

	/*
	* Check whether or not the service is supported.
	* If the script doesn't find any JSON, assume a 'service on demand' install.
	* If a JSON is found, check if the IP type is supported.
	* Invalidate the service_name if it is not supported.
	*/
	handleCheckService : function(s, service_name, ipv6, ev, section_id) {

		var value = service_name.formvalue(section_id);
		s.service_supported = null;
		service_name.triggerValidation(section_id);

		return this.handleGetServiceData(value)
			.then(L.bind(function (service_data) {
				if (value != '-' && service_data) {
					service_data = JSON.parse(service_data);
					if (ipv6.formvalue(section_id) == "1" && !service_data.ipv6) {
						s.service_supported = false;
						return;
					}
				}
				s.service_supported = true;
			}, service_name))
			.then(L.bind(service_name.triggerValidation, service_name, section_id))
	},

	handleGetServiceData: function(service) {
		return Promise.all([
			L.resolveDefault(fs.read('/usr/share/ddns/custom/'+service+'.json'), null),
			L.resolveDefault(fs.read('/usr/share/ddns/default/'+service+'.json'), null)
		]).then(function(data) {
			return data[0] || data[1] || null;
		})
	},

	handleInstallService: function(m, service_name, section_id, section, _this, ev) {
		var service = service_name.formvalue(section_id)
		return fs.exec('/usr/bin/ddns', ['service', 'install', service])
			.then(L.bind(_this.callGenServiceList, _this))
			.then(L.bind(m.render, m))
			.then(L.bind(this.renderMoreOptionsModal, this, section))
			.catch(function(e) { ui.addNotification(null, E('p', e.message)) });
	},

	handleRefreshServicesList: function(m, ev) {
		return fs.exec('/usr/bin/ddns', ['service', 'update'])
			.then(L.bind(this.load, this))
			.then(L.bind(this.render, this))
			.catch(function(e) { ui.addNotification(null, E('p', e.message)) });
	},

	handleReloadDDnsRule: function(m, section_id, ev) {
		return fs.exec('/usr/lib/ddns/dynamic_dns_lucihelper.sh',
							[ '-S', section_id, '--', 'start' ])
			.then(L.bind(m.load, m))
			.then(L.bind(m.render, m))
			.catch(function(e) { ui.addNotification(null, E('p', e.message)) });
	},

	handleStopDDnsRule: function(m, section_id, ev) {
		return fs.exec('/usr/lib/ddns/dynamic_dns_lucihelper.sh',
							[ '-S', section_id, '--', 'stop' ])
			.then(L.bind(m.load, m))
			.then(L.bind(m.render, m))
			.catch(function(e) { ui.addNotification(null, E('p', e.message)) });
	},

	handleToggleDDns: function(m, ev) {
		return this.callInitAction('ddns', 'enable')
			.then(L.bind(function (action) { return this.callInitAction('ddns', action ? 'disable' : 'enable')}, this))
			.then(L.bind(function (action) { return this.callInitAction('ddns', action ? 'stop' : 'start')}, this))
			.then(L.bind(m.render, m))
			.catch(function(e) { ui.addNotification(null, E('p', e.message)) });
	},

	handleRestartDDns: function(m, ev) {
		return this.callInitAction('ddns', 'restart')
			.then(L.bind(m.render, m));
	},

	poll_status: function(map, data) {
		var status = data[1] || [], service = data[0] || [], rows = map.querySelectorAll('.cbi-section-table-row[data-sid]'),
			ddns_enabled = map.querySelector('[data-name="_enabled"]').querySelector('.cbi-value-field'),
			ddns_toggle = map.querySelector('[data-name="_toggle"]').querySelector('button'),
			services_list = map.querySelector('[data-name="_services_list"]').querySelector('.cbi-value-field');

		ddns_toggle.innerHTML = status['_enabled'] ? _('Stop DDNS') : _('Start DDNS');
		ddns_toggle.className = status['_enabled'] 
			? 'cbi-button cbi-button-negative' 
			: 'cbi-button cbi-button-positive';
		services_list.innerHTML = status['_services_list'];

		dom.content(ddns_enabled, function() {
			return E([], [
				E('div', {}, status['_enabled'] ? _('DDNS Autostart enabled') : [
					_('DDNS Autostart disabled'),
					E('div', { 'class' : 'cbi-value-description' },
					_("Currently DDNS updates are not started at boot or on interface events.") + "<br />" +
					_("This is the default if you run DDNS scripts by yourself (i.e. via cron with force_interval set to '0')"))
				]),]);
		});

		for (var i = 0; i < rows.length; i++) {
			const section_id = rows[i].getAttribute('data-sid');
			const cfg_detail_ip = rows[i].querySelector('[data-name="_cfg_detail_ip"]');
			const cfg_update = rows[i].querySelector('[data-name="_cfg_update"]');
			const cfg_status = rows[i].querySelector('[data-name="_cfg_status"]');
			const reload = rows[i].querySelector('.cbi-section-actions .reload');
			const stop = rows[i].querySelector('.cbi-section-actions .stop');
			const cfg_enabled = uci.get('ddns', section_id, 'enabled');

			reload.disabled = (status['_enabled'] == 0 || cfg_enabled == 0);
			stop.disabled = (!service[section_id].pid);

			const host = uci.get('ddns', section_id, 'lookup_host') || _('Configuration Error');
			const ip = service[section_id]?.ip || _('No Data');
			const last_update = service[section_id]?.last_update || _('Never');
			const next_update = this.NextUpdateStrings[service[section_id]?.next_update] || service[section_id]?.next_update || _('Unknown');
			const next_check = this.NextUpdateStrings[service[section_id]?.next_check] || service[section_id]?.next_check || _('Unknown');
			const service_status = service[section_id]?.pid ? '<b>' + _('Running') + '</b> : ' + service[section_id]?.pid : '<b>' + _('Not Running') + '</b>';

			cfg_detail_ip.innerHTML = host + '<br />' + ip;
			cfg_update.innerHTML = last_update + '<br />' + next_check + '<br />' + next_update ;
			cfg_status.innerHTML = service_status;
		}

		return;
	},

	load: function() {
		return Promise.all([
			this.callDDnsGetServicesStatus(),
			this.callDDnsGetStatus(),
			this.callDDnsGetEnv(),
			this.callGenServiceList(),
			uci.load('ddns'),
			this.callGetWanInterface()
		]);
	},

	render: function(data) {
		var resolved = data[0] || [];
		var status = data[1] || [];
		var env = data[2] || [];
		var logdir = uci.get('ddns', 'global', 'ddns_logdir') || "/var/log/ddns";
		var wan_interface = data[5];

			this.neighborCache = {};

		var _this = this;

		let m, s, o;

		m = new form.Map('ddns', _('Dynamic DNS'));

		s = m.section(form.NamedSection, 'global', 'ddns',);

		s.tab('info', _('Information'));
		s.tab('global', _('Global Settings'));

		o = s.taboption('info', form.DummyValue, '_version', _('Dynamic DNS Version'));
		o.cfgvalue = function() {
			return status[this.option];
		};

		o = s.taboption('info', form.DummyValue, '_enabled', _('State'));
		o.cfgvalue = function() {
			var res = status[this.option];
			if (!res) {
				this.description = _("Currently DDNS updates are not started at boot or on interface events.") + "<br />" +
				_("This is the default if you run DDNS scripts by yourself (i.e. via cron with force_interval set to '0')")
			}
			return res ? _('DDNS Autostart enabled') : _('DDNS Autostart disabled')
		};

		o = s.taboption('info', form.Button, '_toggle');
		o.title      = '&#160;';
		o.inputtitle = status['_enabled'] ? _('Stop DDNS') : _('Start DDNS');
		o.inputstyle = status['_enabled'] ? 'negative' : 'positive';
		o.onclick = L.bind(this.handleToggleDDns, this, m);

		o = s.taboption('info', form.Button, '_restart');
		o.title      = '&#160;';
		o.inputtitle = _('Restart DDNS');
		o.inputstyle = 'apply';
		o.onclick = L.bind(this.handleRestartDDns, this, m);

		o = s.taboption('info', form.DummyValue, '_services_list', _('Services list last update'));
		o.cfgvalue = function() {
			return status[this.option];
		};

		o = s.taboption('info', form.Button, '_refresh_services');
		o.title      = '&#160;';
		o.inputtitle = _('Update DDNS Services List');
		o.inputstyle = 'apply';
		o.onclick = L.bind(this.handleRefreshServicesList, this, m);

		// DDns hints

		if (!env['has_ipv6']) {
			o = s.taboption('info', form.DummyValue, '_no_ipv6');
			o.rawhtml  = true;
			o.title = '<b>' + _("IPv6 not supported") + '</b>';
			o.cfgvalue = function() { return _("IPv6 is not supported by this system") + "<br />" +
			_("Please follow the instructions on OpenWrt's homepage to enable IPv6 support") + "<br />" +
			_("or update your system to the latest OpenWrt Release")};
		}

		if (!env['has_ssl']) {
			o = s.taboption('info', form.DummyValue, '_no_https');
			o.titleref = L.url("admin", "system", "package-manager")
			o.rawhtml  = true;
			o.title = '<b>' + _("HTTPS not supported") + '</b>';
			o.cfgvalue = function() { return _("Neither GNU Wget with SSL nor cURL is installed to support secure updates via HTTPS protocol.") +
			"<br />- " +
			_("You should install 'wget' or 'curl' or 'uclient-fetch' with 'libustream-*ssl' package.") +
			"<br />- " +
			_("In some versions cURL/libcurl in OpenWrt is compiled without proxy support.")};
		}

		if (!env['has_bindnet']) {
			o = s.taboption('info', form.DummyValue, '_no_bind_network');
			o.titleref = L.url("admin", "system", "package-manager")
			o.rawhtml  = true;
			o.title = '<b>' + _("Binding to a specific network not supported") + '</b>';
			o.cfgvalue = function() { return _("Neither GNU Wget with SSL nor cURL is installed to select a network to use for communication.") +
			"<br />- " +
			_("This is only a problem with multiple WAN interfaces and your DDNS provider is unreachable via one of them.") +
			"<br />- " +
			_("You should install 'wget' or 'curl' package.") +
			"<br />- " +
			_("GNU Wget will use the IP of given network, cURL will use the physical interface.") +
			"<br />- " +
			_("In some versions cURL/libcurl in OpenWrt is compiled without proxy support.")};
		}

		if (!env['has_proxy']) {
			o = s.taboption('info', form.DummyValue, '_no_proxy');
			o.titleref = L.url("admin", "system", "package-manager")
			o.rawhtml  = true;
			o.title = '<b>' + _("cURL without Proxy Support") + '</b>';
			o.cfgvalue = function() { return _("cURL is installed, but libcurl was compiled without proxy support.") +
			"<br />- " +
			_("You should install 'wget' or 'uclient-fetch' package or replace libcurl.") +
			"<br />- " +
			_("In some versions cURL/libcurl in OpenWrt is compiled without proxy support.")};
		}

		if (!env['has_bindhost']) {
			o = s.taboption('info', form.DummyValue, '_no_dnstcp');
			o.titleref = L.url("admin", "system", "package-manager")
			o.rawhtml  = true;
			o.title = '<b>' + _("DNS requests via TCP not supported") + '</b>';
			o.cfgvalue = function() { return _("BusyBox's nslookup and hostip do not support TCP " +
				"instead of the default UDP when sending requests to the DNS server!") +
				"<br />- " +
				_("Install 'bind-host' or 'knot-host' or 'drill' package if you know you need TCP for DNS requests.")};
		}

		if (!env['has_dnsserver']) {
			o = s.taboption('info', form.DummyValue, '_no_dnsserver');
			o.titleref = L.url("admin", "system", "package-manager")
			o.rawhtml  = true;
			o.title = '<b>' + _("Using specific DNS Server not supported") + '</b>';
			o.cfgvalue = function() { return _("BusyBox's nslookup in the current compiled version " +
			"does not handle given DNS Servers correctly!") +
			"<br />- " +
			_("You should install 'bind-host' or 'knot-host' or 'drill' or 'hostip' package, " +
			"if you need to specify a DNS server to detect your registered IP.")};
		}

		if (env['has_ssl'] && !env['has_cacerts']) {
			o = s.taboption('info', form.DummyValue, '_no_certs');
			o.titleref = L.url("admin", "system", "package-manager")
			o.rawhtml  = true;
			o.title = '<b>' + _("No certificates found") + '</b>';
			o.cfgvalue = function() { return _("If using secure communication you should verify server certificates!") +
			"<br />- " +
			_("Install 'ca-certificates' package or needed certificates " +
				"by hand into /etc/ssl/certs default directory")};
		}

		// Advanced Configuration Section

		o = s.taboption('global', form.Flag, 'upd_privateip', _("Allow non-public IPs"));
		o.description = _("Non-public and by default blocked IPs") + ':'
		+ '<br /><strong>IPv4: </strong>'
		+ '0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16'
		+ '<br /><strong>IPv6: </strong>'
		+ '::/32, f000::/4';
		o.default = "0";
		o.optional = true;

		o = s.taboption('global', form.Value, 'ddns_dateformat', _('Date format'));
		o.description = '<a href="http://www.cplusplus.com/reference/ctime/strftime/" target="_blank">'
			+ _("For supported codes look here")
			+ '</a><br />' +
			_('Current setting: ') + '<b>' + status['_curr_dateformat'] + '</b>';
		o.default = "%F %R"
		o.optional = true;
		o.rmempty = true;

		o = s.taboption('global', form.Value, 'ddns_rundir', _('Status directory'));
		o.description = _('Contains PID and other status information for each running section.');
		o.default = "/var/run/ddns";
		o.optional = true;
		o.rmempty = true;

		o = s.taboption('global', form.Value, 'ddns_logdir', _('Log directory'));
		o.description = _('Contains Log files for each running section.');
		o.default = "/var/log/ddns";
		o.optional = true;
		o.rmempty = true;
		o.validate = function(section_id, formvalue) {
			if (formvalue.indexOf('../') !== -1)
				return _('"../" not allowed in path for Security Reason.')

			return true;
		}

		o = s.taboption('global', form.Value, 'ddns_loglines', _('Log length'));
		o.description = _('Number of last lines stored in log files');
		o.datatype = 'min(1)';
		o.default = '250';

		if (env['has_wget'] && env['has_curl']) {

			o = s.taboption('global', form.Flag, 'use_curl', _('Use cURL'));
			o.description = _('If Wget and cURL package are installed, Wget is used for communication by default.');
			o.default = "0";
			o.optional = true;
			o.rmempty = true;

		}

		o = s.taboption('global', form.Value, 'cacert', _('CA cert bundle file'));
		o.description = _('CA certificate bundle file that will be used to download services data. Set IGNORE to skip certificate validation.');
		o.placeholder = 'IGNORE';
		o.write = function(section_id, value) {
			uci.set('ddns', section_id, 'cacert', value == 'ignore' ? value.toUpperCase() : value);
		};

		o = s.taboption('global', form.Value, 'services_url', _('Services URL Download'));
		o.description = _('Source URL for services file. Defaults to the master openwrt ddns package repo.');
		o.placeholder = 'https://raw.githubusercontent.com/openwrt/packages/master/net/ddns-scripts/files';

		// DDns services
		s = m.section(form.GridSection, 'service', _('DDNS Services'));
		s.anonymous = true;
		s.addremove = true;
		s.addbtntitle = _('Add new service...');
		s.sortable  = true;

		s.handleCreateDDnsRule = function(m, name, service_name, ipv6, ev) {
			var section_id = name.isValid('_new_') ? name.formvalue('_new_') : null,
				service_value = service_name.isValid('_new_') ? service_name.formvalue('_new_') : null,
				ipv6_value = ipv6.isValid('_new_') ? ipv6.formvalue('_new_') : null;

			if (!section_id || !service_value || !ipv6_value)
				return;

			return m.save(function() {
				uci.add('ddns', 'service', section_id);
				if (service_value != '-') {
					uci.set('ddns', section_id, 'service_name', service_value);
				}
				uci.set('ddns', section_id, 'use_ipv6', ipv6_value);
				ui.hideModal();
			}).then(L.bind(m.children[1].renderMoreOptionsModal, m.children[1], section_id));
		};

		s.handleAdd = function(ev) {
			var m2 = new form.Map('ddns'),
				s2 = m2.section(form.NamedSection, '_new_'),
				name, ipv6, service_name;

			s2.render = function() {
				return Promise.all([
					{},
					this.renderUCISection('_new_')
				]).then(this.renderContents.bind(this));
			};

			name = s2.option(form.Value, 'name', _('Name'));
			name.rmempty = false;
			name.datatype = 'uciname';
			name.placeholder = _('New DDns Service…');
			name.validate = function(section_id, value) {
				if (uci.get('ddns', value) != null)
					return _('The service name is already used');

				return true;
			};

			ipv6 = s2.option( form.ListValue, 'use_ipv6',
				_("IP address version"),
				_("Which record type to update at the DDNS provider (A/AAAA)"));
			ipv6.default = '0';
			ipv6.value("0", _("IPv4-Address"))
			if (env["has_ipv6"]) {
				ipv6.value("1", _("IPv6-Address"))
			}

			service_name = s2.option(form.ListValue, 'service_name',
					String.format('%s', _("DDNS Service provider")));
			service_name.value('-',"📝 " + _("custom") );
			Object.keys(_this.services).sort().forEach(name => service_name.value(name));
			service_name.validate = function(section_id, value) {
				if (value == '-') return true;
				if (!value) return _("Select a service");
				if (!s2.service_supported) return _("Service doesn't support this IP type");
				return true;
			};

			ipv6.onchange = L.bind(_this.handleCheckService, _this, s2, service_name, ipv6);
			service_name.onchange = L.bind(_this.handleCheckService, _this, s2, service_name, ipv6);

			m2.render().then(L.bind(function(nodes) {
					ui.showModal(_('Add new DDNS service'), [
						nodes,
						E('div', { 'class': 'right', 'style': 'margin-top: 1em;' }, [
							E('button', {
								'class': 'btn',
								'click': ui.hideModal
							}, _('Cancel')), ' ',
							E('button', {
								'class': 'cbi-button cbi-button-positive important',
								'click': ui.createHandlerFn(this, 'handleCreateDDnsRule', m, name, service_name, ipv6)
							}, _('Create service'))
						])
					], 'cbi-modal');

				nodes.querySelector('[id="%s"] input[type="text"]'.format(name.cbid('_new_'))).focus();
			}, this));
		};

		s.renderRowActions = function(section_id) {
			var tdEl = this.super('renderRowActions', [ section_id, _('Edit') ]),
				cfg_enabled = uci.get('ddns', section_id, 'enabled'),
				reload_opt = {
					'class': 'cbi-button cbi-button-neutral reload',
					'click': ui.createHandlerFn(_this, 'handleReloadDDnsRule', m, section_id),
					'title': _('Reload this service'),
				},
				stop_opt = {
					'class': 'cbi-button cbi-button-neutral stop',
					'click': ui.createHandlerFn(_this, 'handleStopDDnsRule', m, section_id),
					'title': _('Stop this service'),
				};

			if (status['_enabled'] == 0 || cfg_enabled == 0)
				reload_opt['disabled'] = 'disabled';

			if (!resolved[section_id] || !resolved[section_id].pid ||
					(resolved[section_id].pid && cfg_enabled == '1'))
				stop_opt['disabled'] = 'disabled';

			dom.content(tdEl.lastChild, [
				E('button', stop_opt, _('Stop')),
				E('button', reload_opt, _('Reload')),
				tdEl.lastChild.childNodes[0],
				tdEl.lastChild.childNodes[1],
				tdEl.lastChild.childNodes[2]
			]);

			return tdEl;
		};

		s.modaltitle = function(section_id) {
			return _('DDNS Service') + ' » ' + section_id;
		};

		s.addModalOptions = function(s, section_id) {

			var service = uci.get('ddns', section_id, 'service_name') || '-',
				ipv6 = uci.get('ddns', section_id, 'use_ipv6'), service_name, use_ipv6;

			return _this.handleGetServiceData(service).then(L.bind(function (service_data) {
				s.service_available = true;
				s.service_supported = true;
				s.url = null;

				if (service != '-') {
					if (!service_data)
						s.service_available = false;
					else {
						service_data = JSON.parse(service_data);
						if (ipv6 == "1" && !service_data.ipv6)
							s.service_supported = false;
						else if (ipv6 == "1") {
							s.url = service_data.ipv6.url;
						} else {
							s.url = service_data.ipv4.url;
						}
					}
				}

				s.tab('basic', _('Basic Settings'));
				s.tab('advanced', _('Advanced Settings'));
				s.tab('timer', _('Timer Settings'));
				s.tab('logview', _('Log File Viewer'));

				o = s.taboption('basic', form.Flag, 'enabled',
					_('Enabled'),
					_("If this service section is disabled it will not be started.")
					+ "<br />" +
					_("Neither from LuCI interface nor from console."));
				o.modalonly = true;
				o.rmempty  = false;
				o.default = '1';

				o = s.taboption('basic', form.Value, 'lookup_host',
					_("Lookup Hostname"),
					_("Hostname/FQDN to validate, whether an IP update is necessary"));
				o.rmempty = false;
				o.placeholder = "myhost.example.com";
				o.datatype = 'and(minlength(3),hostname("strict"))';
				o.modalonly = true;

				use_ipv6 = s.taboption('basic', form.ListValue, 'use_ipv6',
					_("IP address version"),
					_("Which record type to update at the DDNS provider (A/AAAA)"));
				use_ipv6.default = '0';
				use_ipv6.modalonly = true;
				use_ipv6.rmempty  = false;
				use_ipv6.value("0", _("IPv4-Address"))
				if (env["has_ipv6"]) {
					use_ipv6.value("1", _("IPv6-Address"))
				}

				service_name = s.taboption('basic', form.ListValue, 'service_name',
					String.format('%s', _("DDNS Service provider")));
				service_name.modalonly = true;
				service_name.value('-',"📝 " + _("custom") );
				Object.keys(_this.services).sort().forEach(name => service_name.value(name));
				service_name.cfgvalue = function(section_id) {
					return uci.get('ddns', section_id, 'service_name') || '-';
				};
				service_name.write = function(section_id, service) {
					if (service != '-') {
						uci.unset('ddns', section_id, 'update_url');
						uci.unset('ddns', section_id, 'update_script');
						return uci.set('ddns', section_id, 'service_name', service);
					}
					return uci.unset('ddns', section_id, 'service_name');
				};
				service_name.validate = function(section_id, value) {
					if (value == '-') return true;
					if (!value) return _("Select a service");
					if (!s.service_available) return _('Service not installed');
					if (!s.service_supported) return _("Service doesn't support this IP type");
					return true;
				};

				service_name.onchange = L.bind(_this.handleCheckService, _this, s, service_name, use_ipv6);
				use_ipv6.onchange = L.bind(_this.handleCheckService, _this, s, service_name, use_ipv6);

				if (!s.service_available) {
					o = s.taboption('basic', form.Button, '_download_service');
					o.modalonly  = true;
					o.title      = _('Service not installed');
					o.inputtitle = _('Install Service');
					o.inputstyle = 'apply';
					o.onclick = L.bind(_this.handleInstallService,
						this, m, service_name, section_id, s.section, _this)
				}

				if (!s.service_supported) {
					o = s.taboption('basic', form.DummyValue, '_not_supported', '&nbsp');
					o.cfgvalue = function () {
						return _("Service doesn't support this IP type")
					};
				}

				if (Boolean(s.url)) {
					o = s.taboption('basic', form.DummyValue, '_url', _("Update URL"));
					o.rawhtml = true;
					o.default = '<div style="font-family: monospace;">'
						+ s.url.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
						+ '</div>';
				}

				var service_switch = s.taboption('basic', form.Button, '_switch_proto');
				service_switch.modalonly  = true;
				service_switch.title      = _('Really switch service?');
				service_switch.inputtitle = _('Switch service');
				service_switch.inputstyle = 'apply';
				service_switch.onclick = L.bind(function(ev) {
					if (!s.service_supported) return;

					return s.map.save()
						.then(L.bind(m.load, m))
						.then(L.bind(m.render, m))
						.then(L.bind(this.renderMoreOptionsModal, this, s.section));
				}, this);

				if (s.service_available && s.service_supported) {

					var ipInterfaceOption;
					var ipNetworkOption;
					var ipDeviceOption;
					var eventNetworkOption;

					o = s.taboption('basic', form.Value, 'update_url',
						_("Custom update-URL"),
						_("Update URL for updating your DDNS Provider.")
						+ "<br />" +
						_("Follow instructions found on their WEB page."));
					o.modalonly = true;
					o.rmempty = true;
					o.optional = true;
					o.depends("service_name","-");
					o.validate = function(section_id, value) {
						var other = this.section.formvalue(section_id, 'update_script');
						if ((!value && !other) || (value && other)) {
							return _("Provide either an Update Script OR an Update URL");
						}

						return true;
					};

					o = s.taboption('basic', form.FileUpload, 'update_script',
						_("Custom update-script"),
						_("Custom update script for updating your DDNS Provider."));
					o.root_directory = '/usr/lib/ddns/';
					o.datatype = 'file';
					o.show_hidden = true;
					o.enable_upload = true;
					o.enable_remove = true;
					o.enable_download = true;
					o.modalonly = true;
					o.rmempty = true;
					o.optional = true;
					o.depends("service_name","-");
					o.validate = function(section_id, value) {
						var other = this.section.formvalue(section_id, 'update_url');
						if ((!value && !other) || (value && other)) {
							return _("Provide either an Update Script OR an Update URL");
						}

						return true;
					};

					o = s.taboption('basic', form.Value, 'domain',
						_("Domain"),
						_("Replaces [DOMAIN] in Update-URL (URL-encoded)"));
					o.modalonly = true;
					o.rmempty = false;

					o = s.taboption('basic', form.Value, 'username',
						_("Username"),
						_("Replaces [USERNAME] in Update-URL (URL-encoded)"));
					o.modalonly = true;
					o.rmempty = false;

					o = s.taboption('basic', form.Value, 'password',
						_("Password"),
						_("Replaces [PASSWORD] in Update-URL (URL-encoded)")
						+ '<br/>' +
						_("A.k.a. the TOKEN at e.g. afraid.org"));
					o.password = true;
					o.modalonly = true;
					o.rmempty = false;

					o = s.taboption('advanced', form.ListValue, 'ip_source',
						_("IP address source"),
						_("Method used to determine the system IP-Address to send in updates")
						+ '<br /><small style="color:#888">'
						+ _('IPv6 sources (PD/DHCPv6/SLAAC/EUI-64) require IPv6 mode enabled.')
						+ '</small>');
					o.modalonly = true;
					o.default = 'network';
					// Common sources
					o.value('network', '🌐 ' + _("Network") + ' - ' + _('Read IP from netifd'));
					o.value('interface', '🔌 ' + _("Interface") + ' - ' + _('Read IP from physical interface'));
					o.value('web', '🔗 ' + _("URL") + ' - ' + _('Detect via external web service'));
					o.value('script', '📜 ' + _("Script") + ' - ' + _('Custom script'));
					// IPv6-specific sources
					o.value('prefix', '📡 ' + _("IPv6 Prefix (PD)") + ' - ' + _('Build from delegated prefix'));
					o.value('dhcpv6', '🏠 ' + _("DHCPv6") + ' - ' + _('Stateful DHCPv6 address'));
					o.value('slaac', '🔄 ' + _("SLAAC") + ' - ' + _('Stateless auto-configuration'));
					o.value('eui64', '🔢 ' + _("EUI-64") + ' - ' + _('MAC-based IPv6 address'));
					o.value('device', '📱 ' + _("Device") + ' - ' + _('Monitor neighbor IPv6 by MAC'));
					o.write = function(section_id, formvalue) {
						switch (formvalue) {
						case 'network':
							uci.unset('ddns', section_id, 'ip_url');
							uci.unset('ddns', section_id, 'ip_interface');
							uci.unset('ddns', section_id, 'ip_script');
							uci.unset('ddns', section_id, 'ip_prefix_suffix');
							break;
						case 'web':
							uci.unset('ddns', section_id, 'ip_network');
							uci.unset('ddns', section_id, 'ip_interface');
							uci.unset('ddns', section_id, 'ip_script');
							uci.unset('ddns', section_id, 'ip_prefix_suffix');
							break;
						case 'interface':
							uci.unset('ddns', section_id, 'ip_network');
							uci.unset('ddns', section_id, 'ip_url');
							uci.unset('ddns', section_id, 'ip_script');
							uci.unset('ddns', section_id, 'ip_prefix_suffix');
							break;
						case 'script':
							uci.unset('ddns', section_id, 'ip_network');
							uci.unset('ddns', section_id, 'ip_url');
							uci.unset('ddns', section_id, 'ip_interface');
							uci.unset('ddns', section_id, 'ip_device');
							uci.unset('ddns', section_id, 'ip_prefix_suffix');
							break;
						case 'device':
							uci.unset('ddns', section_id, 'ip_url');
							uci.unset('ddns', section_id, 'ip_script');
							uci.unset('ddns', section_id, 'ip_prefix_suffix');
							break;
						case 'prefix':
							uci.unset('ddns', section_id, 'ip_url');
							uci.unset('ddns', section_id, 'ip_script');
							break;
						case 'dhcpv6':
						case 'slaac':
						case 'eui64':
							uci.unset('ddns', section_id, 'ip_url');
							uci.unset('ddns', section_id, 'ip_script');
							uci.unset('ddns', section_id, 'ip_prefix_suffix');
							break;
						default:
							break;
						}

						return uci.set('ddns', section_id, 'ip_source', formvalue);
					};

					o = s.taboption('advanced', widgets.NetworkSelect, 'ip_network',
						_("Network"),
						_("Defines the network to read systems IP-Address from"));
					o.depends('ip_source', 'network');
					o.depends('ip_source', 'prefix');
					o.depends('ip_source', 'dhcpv6');
					o.depends('ip_source', 'slaac');
					o.depends('ip_source', 'eui64');
					o.modalonly = true;
					o.default = 'wan';
					o.multiple = false;
					o.renderWidget = function(section_id, option_index, cfgvalue) {
						var base = (widgets.NetworkSelect.prototype && widgets.NetworkSelect.prototype.renderWidget)
							? widgets.NetworkSelect.prototype.renderWidget
							: form.ListValue.prototype.renderWidget;
						return base.call(this, section_id, option_index, cfgvalue);
					};
					ipNetworkOption = o;

					o = s.taboption('advanced', form.Value, 'ip_prefix_suffix',
						_("IPv6 Suffix"),
						_("Interface identifier suffix to append to the IPv6 prefix (PD).")
						+ '<br />' +
						_("Format: ::XXXX or ::XXXX:XXXX:XXXX:XXXX (hexadecimal)")
						+ '<br />' +
						_("Example: If prefix is 2001:db8:1234::/48 and suffix is ::1, result is 2001:db8:1234::1"));
					o.depends('ip_source', 'prefix');
					o.modalonly = true;
					o.optional = true;
					o.placeholder = '::1';
					o.rmempty = true;
					o.validate = function(section_id, value) {
						if (!value || value == '')
							return true;
						// Validate IPv6 suffix format: must start with :: and contain valid hex
						if (!/^::[0-9a-fA-F:]+$/.test(value))
							return _('Invalid IPv6 suffix format. Must start with :: followed by hexadecimal digits.');
						// Check for valid IPv6 characters and structure
						var parts = value.substring(2).split(':');
						for (var i = 0; i < parts.length; i++) {
							if (parts[i].length > 4 || !/^[0-9a-fA-F]*$/.test(parts[i]))
								return _('Each segment must be 1-4 hexadecimal characters.');
						}
						return true;
					};

					o = s.taboption('advanced', form.Value, 'ip_url',
						_("URL to detect"),
						_("Defines the Web page to read systems IP-Address from.")
						+ '<br />' +
						String.format('%s %s', _('Example for IPv4'), ': http://checkip.dyndns.com')
						+ '<br />' +
						String.format('%s %s', _('Example for IPv6'), ': http://checkipv6.dyndns.com'));
					o.depends('ip_source', 'web');
					o.modalonly = true;

					o = s.taboption('advanced', widgets.DeviceSelect, 'ip_interface',
						_("Interface"),
						_("Defines the interface to read systems IP-Address from"));
					o.modalonly = true;
					o.depends('ip_source', 'interface');
					o.depends('ip_source', 'device');
					o.depends('ip_source', 'dhcpv6');
					o.depends('ip_source', 'slaac');
					o.depends('ip_source', 'eui64');
					o.multiple = false;
					o.default = wan_interface;
					ipInterfaceOption = o;

					o = s.taboption('advanced', form.Value, 'ip_device',
						_('Target device'),
						_('Identify a downstream device by MAC address, hostname, IPv4 address, or DUID. ' +
						  'Leave empty to use the router\'s own address.'));
					o.modalonly = true;
					o.depends('ip_source', 'device');
					o.depends('ip_source', 'prefix');
					o.depends('ip_source', 'dhcpv6');
					o.depends('ip_source', 'slaac');
					o.depends('ip_source', 'eui64');
					o.rmempty = true;
					o.placeholder = _('MAC / hostname / IPv4 / DUID');
					o.validate = function(section_id, value) {
						var v = String(value || '').trim();
						var ipSource = uci.get('ddns', section_id, 'ip_source');
						// Required only for 'device' source
						if (ipSource === 'device' && !v)
							return _('Please enter a device identifier for source "device".');
						if (!v)
							return true;
						// MAC address pattern
						if (/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(v))
							return true;
						// IPv4 address pattern
						if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v))
							return true;
						// DUID pattern (starts with 00:0x:)
						if (/^00:0[1-4]:/.test(v))
							return true;
						// Hostname pattern (alphanumeric with dashes/dots)
						if (/^[a-zA-Z][a-zA-Z0-9\-\.]*$/.test(v))
							return true;
						return _('Invalid format. Accepted: MAC address, hostname, IPv4 address, or DUID.');
					};
					o.write = function(section_id, value) {
						var v = String(value || '').trim();
						if (!v)
							return uci.unset('ddns', section_id, 'ip_device');
						return uci.set('ddns', section_id, 'ip_device', v);
					};
					o.remove = function(section_id) {
						return uci.unset('ddns', section_id, 'ip_device');
					};
					o.renderWidget = function(section_id, option_index, cfgvalue) {
						var option = this;
						var neighborMap = {};
						var currentSource = null;
						var dropdownWidget = null;
						var choices = {};
						var order = [];

						// Format MAC address for display
						var formatMac = function(mac) {
							return (mac || '').toUpperCase();
						};

						// Build choice item with device icon (like DeviceSelect)
						var buildChoiceItem = function(entry) {
							var mac = entry.mac ? String(entry.mac).trim().toLowerCase() : '';
							var host = entry.hostname || null;
							var bestAddr = entry.bestAddress || null;
							var matchesPD = entry.bestAddressMatchesPD || false;
							var hasPDMatch = entry.hasPDMatch || false;

							// Build label similar to DeviceSelect style
							var addrDisplay = null;
							if (bestAddr) {
								// Color code: green for PD match (publicly accessible), orange for no match
								var addrStyle = matchesPD ? 'color:#080;' : 'color:#a50;';
								var addrIcon = matchesPD ? '✓' : '⚠';
								var addrTitle = matchesPD ? _('Matches network prefix - publicly accessible') : _('Does not match network prefix - may not be publicly accessible');
								addrDisplay = E('span', { 
									'style': addrStyle + ' margin-left:6px;',
									'title': addrTitle
								}, addrIcon + ' ' + bestAddr);
							}

							// Build label similar to DeviceSelect style
							return E('span', { 'class': 'ifacebadge' }, [
								E('img', {
									'src': L.resource('icons/ethernet.svg'),
									'title': host || formatMac(mac),
									'style': 'width:16px; height:16px; vertical-align:middle; margin-right:4px;'
								}),
								E('span', { 'class': 'hide-open' }, host ? host : formatMac(mac)),
								E('span', { 'class': 'hide-close' }, [
									host ? E('strong', {}, host + ' ') : null,
									E('span', { 'style': 'font-family:monospace;' }, formatMac(mac)),
									addrDisplay
								].filter(Boolean))
							]);
						};

						// Initial empty choice
						choices[''] = E('em', {}, _('-- Select neighbor device --'));
						order.push('');

						// If we have a saved value, add it as an option
						if (cfgvalue) {
							var savedMac = String(cfgvalue).trim().toLowerCase();
							choices[savedMac] = E('span', { 'class': 'ifacebadge' }, [
								E('img', {
									'src': L.resource('icons/ethernet.svg'),
									'style': 'width:16px; height:16px; vertical-align:middle; margin-right:4px;'
								}),
								E('span', {}, formatMac(savedMac))
							]);
							order.push(savedMac);
						}

						// Create the dropdown widget
						dropdownWidget = new ui.Dropdown(cfgvalue || '', choices, {
							id: this.cbid(section_id),
							sort: order,
							optional: true,
							select_placeholder: E('em', _('-- Select neighbor device --')),
							custom_placeholder: E('em', _('Enter MAC / hostname / IPv4 / DUID...')),
							display_items: 5,
							dropdown_items: -1,
							create: true,
							create_query: '.create-item-input',
							create_template: 'script[type="item-template"]'
						});

						var dropdownEl = dropdownWidget.render();

						// Refresh button
						var refresh = E('button', {
							'class': 'cbi-button cbi-button-action',
							'type': 'button',
							'style': 'margin-left:8px; flex-shrink:0;'
						}, [ _('Scan') ]);

						// Status display
						var status = E('div', {
							'class': 'cbi-value-description',
							'style': 'margin-top:8px;'
						});

						// Control row with dropdown and refresh button
						var controlRow = E('div', {
							'class': 'control-group',
							'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:4px;'
						}, [
							E('div', { 'style': 'flex:1; min-width:200px;' }, dropdownEl),
							refresh
						]);

						var wrapper = E('div', { 'style': 'width:100%;' }, [
							controlRow,
							status
						]);

						// Update dropdown choices
						var rebuildDropdown = function(list) {
							neighborMap = {};
							var newChoices = {};
							var newValues = [];

							// Add device options
							list.forEach(function(entry) {
								var mac = entry.mac ? String(entry.mac).trim().toLowerCase() : '';
								if (!mac)
									return;
								neighborMap[mac] = entry;
								newChoices[mac] = buildChoiceItem(entry);
								newValues.push(mac);
							});

							// Update dropdown using clearChoices + addChoices
							if (dropdownWidget) {
								dropdownWidget.clearChoices();
								if (newValues.length > 0)
									dropdownWidget.addChoices(newValues, newChoices);
							}
						};

						// Sync related options
						var syncRelatedOptions = function(entry) {
							if (!entry)
								return;
							var assignIfEmpty = function(opt, value) {
								if (!opt || !value)
									return;
								var widgetEl = opt.getUIElement(section_id);
								if (!widgetEl || typeof widgetEl.getValue !== 'function' || typeof widgetEl.setValue !== 'function')
									return;
								var current = widgetEl.getValue();
								if (!current || current === '--')
									widgetEl.setValue(value);
							};

							if (currentSource && currentSource.interface)
								assignIfEmpty(ipInterfaceOption, currentSource.interface);
							if (currentSource && currentSource.network) {
								assignIfEmpty(ipNetworkOption, currentSource.network);
								assignIfEmpty(eventNetworkOption, currentSource.network);
							}
						};

						// Perform refresh/scan
						var performRefresh = function(force) {
							refresh.disabled = true;
							dom.content(status, E('em', { 'class': 'spinning' }, _('Scanning for IPv6 neighbors…')));

							return _this.fetchDeviceChoices(section_id, option.section, { force: force }).then(function(result) {
								currentSource = result && result.source ? result.source : null;
								rebuildDropdown(result && result.choices ? result.choices : []);

								if (result && result.message) {
									dom.content(status, result.message);
								} else if (Object.keys(neighborMap).length === 0) {
									dom.content(status, E('em', {}, _('No IPv6 neighbors detected. Try scanning again.')));
								} else {
									var count = Object.keys(neighborMap).length;
									dom.content(status, E('span', { 'style': 'color:#080;' }, 
										'✓ ' + String.format(_('Found %d device(s)'), count)));
								}
								refresh.disabled = false;
								return result;
							}, function(err) {
								currentSource = null;
								rebuildDropdown([]);
								dom.content(status, E('span', { 'style': 'color:#c00;' }, 
									'✗ ' + _('Failed to query IPv6 neighbors.')));
								refresh.disabled = false;
								return err;
							});
						};

						// Store refresh function for external triggers
						this.neighborWidgets = this.neighborWidgets || {};
						this.neighborWidgets[section_id] = performRefresh;

						// Handle dropdown value change
						dropdownEl.addEventListener('cbi-dropdown-change', function(ev) {
							var selectedValue = dropdownWidget.getValue();
							if (selectedValue && neighborMap[selectedValue]) {
								syncRelatedOptions(neighborMap[selectedValue]);
							}
						});

						// Refresh button click handler
						refresh.addEventListener('click', function(ev) {
							ev.preventDefault();
							performRefresh(true);
						});

						// Initial scan
						performRefresh(false);

						// Show initial status
						if (!cfgvalue) {
							dom.content(status, E('em', {}, _('Click "Scan" to discover IPv6 neighbor devices.')));
						}

						return wrapper;
					};
					ipDeviceOption = o;

					// Device identifier type selection
					o = s.taboption('advanced', form.ListValue, 'ip_device_type',
						_('Device identifier type'),
						_('How to identify the target device. Auto-detect works for most cases.'));
					o.modalonly = true;
					o.depends('ip_source', 'device');
					o.depends('ip_source', 'prefix');
					o.depends('ip_source', 'dhcpv6');
					o.depends('ip_source', 'slaac');
					o.depends('ip_source', 'eui64');
					o.value('auto', _('Auto-detect'));
					o.value('mac', _('MAC address'));
					o.value('hostname', _('Hostname'));
					o.value('ipv4', _('IPv4 address'));
					o.value('duid', _('DUID (DHCPv6)'));
					o.default = 'auto';
					o.rmempty = true;

					if (ipInterfaceOption) {
						ipInterfaceOption.onchange = L.bind(function(section_id) {
							if (ipDeviceOption && ipDeviceOption.neighborWidgets && ipDeviceOption.neighborWidgets[section_id])
								ipDeviceOption.neighborWidgets[section_id](true);
						}, this);
					}

					if (ipNetworkOption) {
						ipNetworkOption.onchange = L.bind(function(section_id) {
							if (ipDeviceOption && ipDeviceOption.neighborWidgets && ipDeviceOption.neighborWidgets[section_id])
								ipDeviceOption.neighborWidgets[section_id](true);
						}, this);
					}

					o = s.taboption('advanced', form.Value, 'ip_script',
						_("Script"),
						_("User defined script to read system IP-Address"));
					o.modalonly = true;
					o.depends("ip_source", "script")
					o.placeholder = "/path/to/script.sh"

					o = s.taboption('advanced', widgets.NetworkSelect, 'interface',
						_("Event Network"),
						_("Network on which the ddns-updater scripts will be started"));
					o.modalonly = true;
					o.multiple = false;
					o.default = 'wan';
					o.depends("ip_source", "web");
					o.depends("ip_source", "script");
					o.depends("ip_source", "interface");
					o.depends("ip_source", "device");
					o.depends("ip_source", "prefix");
					o.depends("ip_source", "dhcpv6");
					o.depends("ip_source", "slaac");
					o.depends("ip_source", "eui64");
					o.renderWidget = function(section_id, option_index, cfgvalue) {
						var base = (widgets.NetworkSelect.prototype && widgets.NetworkSelect.prototype.renderWidget)
							? widgets.NetworkSelect.prototype.renderWidget
							: form.ListValue.prototype.renderWidget;
						var widget = base.call(this, section_id, option_index, cfgvalue);
						if (widget && widget.querySelectorAll) {
							widget.querySelectorAll('select.cbi-input-select').forEach(function(select) {
								select.style.minWidth = '18rem';
								select.style.minHeight = '2.5rem';
								select.style.lineHeight = '2.1rem';
								select.style.paddingTop = '0.2rem';
								select.style.paddingBottom = '0.2rem';
							});
							widget.querySelectorAll('.cbi-dropdown').forEach(function(dropdown) {
								dropdown.style.minHeight = '2.5rem';
							});
						}
						return widget;
					};
					eventNetworkOption = o;

					o = s.taboption('advanced', form.DummyValue, '_interface',
						_("Event Network"),
						_("Network on which the ddns-updater scripts will be started"));
					o.depends("ip_source", "network");
					o.depends("ip_source", "prefix");
					o.forcewrite = true;
					o.modalonly = true;
					o.cfgvalue = function(section_id) {
						return uci.get('ddns', section_id, 'interface') || _('This will be autoset to the selected interface');
					};
					o.write = function(section_id) {
						var opt = this.section.formvalue(section_id, 'ip_source');
						var val = null;

						switch (opt) {
						case 'network':
						case 'prefix':
							val = this.section.formvalue(section_id, 'ip_network');
							break;
						case 'interface':
						case 'device':
						case 'dhcpv6':
						case 'slaac':
						case 'eui64':
							val = this.section.formvalue(section_id, 'ip_interface');
							break;
						case 'web':
						case 'script':
							val = this.section.formvalue(section_id, 'interface');
							break;
						default:
							break;
						}

						if (val)
							return uci.set('ddns', section_id, 'interface', val);
						return uci.unset('ddns', section_id, 'interface');
					};

					if (env['has_bindnet']) {
						o = s.taboption('advanced', widgets.NetworkSelect, 'bind_network',
							_("Bind Network"),
							_('OPTIONAL: Network to use for communication')
							+ '<br />' +
							_("Network on which the ddns-updater scripts will be started"));
						o.depends("ip_source", "web");
						o.optional = true;
						o.rmempty = true;
						o.modalonly = true;
					}

					if (env['has_forceip']) {
						o = s.taboption('advanced', form.Flag, 'force_ipversion',
							_("Force IP Version"),
							_('OPTIONAL: Force the usage of pure IPv4/IPv6 only communication.'));
						o.optional = true;
						o.rmempty = true;
						o.modalonly = true;
					}

					if (env['has_dnsserver']) {
						o = s.taboption("advanced", form.Value, "dns_server",
							_("DNS-Server"),
							_("OPTIONAL: Use non-default DNS-Server to detect 'Registered IP'.")
							+ "<br />" +
							_("Format: IP or FQDN"));
						o.placeholder = "mydns.lan"
						o.optional = true;
						o.rmempty = true;
						o.modalonly = true;
					}

					if (env['has_bindhost']) {
						o = s.taboption("advanced", form.Flag, "force_dnstcp",
							_("Force TCP on DNS"),
							_("OPTIONAL: Force the use of TCP instead of default UDP on DNS requests."));
						o.optional = true;
						o.rmempty = true;
						o.modalonly = true;
					}

					if (env['has_proxy']) {
						o = s.taboption("advanced", form.Value, "proxy",
							_("PROXY-Server"),
							_("OPTIONAL: Proxy-Server for detection and updates.")
							+ "<br />" +
							String.format('%s: <b>%s</b>', _("Format"), "[user:password@]proxyhost:port")
							+ "<br />" +
							String.format('%s: <b>%s</b>', _("IPv6 address must be given in square brackets"), "[2001:db8::1]:8080"));
						o.optional = true;
						o.rmempty = true;
						o.modalonly = true;
					}

					o = s.taboption("advanced", form.ListValue, "use_syslog",
						_("Log to syslog"),
						_("Writes log messages to syslog. Critical Errors will always be written to syslog."));
					o.modalonly = true;
					o.default = "2"
					o.optional = true;
					o.value("0", _("No logging"))
					o.value("1", _("Info"))
					o.value("2", _("Notice"))
					o.value("3", _("Warning"))
					o.value("4", _("Error"))

					o = s.taboption("advanced", form.Flag, "use_logfile",
						_("Log to file"));
					o.default = '1';
					o.optional = true;
					o.modalonly = true;
					o.cfgvalue = function(section_id) {
						this.description = _("Writes detailed messages to log file. File will be truncated automatically.") + "<br />" +
						_("File") + ': "' + logdir + '/' + section_id + '.log"';
						return uci.get('ddns', section_id, 'use_logfile');
					};


					o = s.taboption("timer", form.Value, "check_interval",
						_("Check Interval"));
					o.placeholder = "10";
					o.modalonly = true;
					o.datatype = 'uinteger';
					o.validate = function(section_id, formvalue) {
						var unit = this.section.formvalue(section_id, 'check_unit'),
							time_to_sec = _this.time_res[unit || 'minutes'] * formvalue;

						if (formvalue && time_to_sec < 300)
							return _('Values below 5 minutes == 300 seconds are not supported');

						return true;
					};

					o = s.taboption("timer", form.ListValue, "check_unit",
						_('Check Unit'),
						_("Interval unit to check for changed IP"));
					o.modalonly = true;
					o.optional = true;
					o.value("seconds", _("seconds"));
					o.value("minutes", _("minutes"));
					o.value("hours", _("hours"));

					o = s.taboption("timer", form.Value, "force_interval",
						_("Force Interval"),
						_("Interval to force an update at the DDNS Provider")
						+ "<br />" +
						_("Setting this parameter to 0 will force the script to only run once"));
					o.placeholder = "72";
					o.optional = true;
					o.modalonly = true;
					o.datatype = 'uinteger';
					o.validate = function(section_id, formvalue) {

						if (!formvalue)
							return true;

						var check_unit = this.section.formvalue(section_id, 'check_unit'),
							check_val = this.section.formvalue(section_id, 'check_interval'),
							force_unit = this.section.formvalue(section_id, 'force_unit'),
							check_to_sec = _this.time_res[check_unit || 'minutes'] * ( check_val || '30'),
							force_to_sec = _this.time_res[force_unit || 'minutes'] * formvalue;

						if (force_to_sec != 0 && force_to_sec < check_to_sec)
							return _("Values lower than 'Check Interval' except '0' are invalid");

						return true;
					};

					o = s.taboption("timer", form.ListValue, "force_unit",
						_('Force Unit'),
						_("Interval unit for forced updates sent to DDNS Provider."));
					o.modalonly = true;
					o.optional = true;
					o.value("minutes", _("minutes"));
					o.value("hours", _("hours"));
					o.value("days", _("days"));

					o = s.taboption("timer", form.Value, "retry_max_count",
						_("Error Max Retry Counter"),
						_("On Error the script will stop execution after the given number of retries.")
						+ "<br />" +
						_("The default setting of '0' will retry infinitely."));
					o.placeholder = "0";
					o.optional = true;
					o.modalonly = true;
					o.datatype = 'uinteger';

					o = s.taboption("timer", form.Value, "retry_interval",
						_("Error Retry Interval"),
  						_("The interval between which each subsequent retry commences."));
					o.placeholder = "60";
					o.optional = true;
					o.modalonly = true;
					o.datatype = 'uinteger';

					o = s.taboption("timer", form.ListValue, "retry_unit",
						_('Retry Unit'),
						_("Which time units to use for retry counters."));
					o.modalonly = true;
					o.optional = true;
					o.value("seconds", _("seconds"));
					o.value("minutes", _("minutes"));

					o = s.taboption('logview', form.Button, '_read_log');
					o.title      = '';
					o.depends('use_logfile','1');
					o.modalonly = true;
					o.inputtitle = _('Read / Reread log file');
					o.inputstyle = 'apply';
					o.onclick = L.bind(function(ev, section_id) {
						return _this.callGetLogServices(section_id).then(L.bind(log_box.update_log, log_box));
					}, this);

					var log_box = s.taboption("logview", form.DummyValue, "_logview");
					log_box.depends('use_logfile','1');
					log_box.modalonly = true;

					log_box.update_log = L.bind(function(view, log_data) {
						return document.getElementById('syslog').textContent = log_data.result;
					}, o, this);

					log_box.render = L.bind(function() {
						return E([
							E('p', {}, _('This is the current content of the log file in %h for this service.').format(logdir)),
							E('p', {}, E('textarea', { 'style': 'width:100%; font-size: 10px', 'rows': 20, 'readonly' : 'readonly', 'id' : 'syslog' }, _('Please press [Read] button') ))
						]);
					}, o, this);
				}

				for (var i = 0; i < s.children.length; i++) {
					o = s.children[i];
					switch (o.option) {
					case '_switch_proto':
						o.depends({ service_name : service, use_ipv6: ipv6, "!reverse": true })
						continue;
					case 'enabled':
					case 'service_name':
					case 'use_ipv6':
					case 'update_script':
					case 'update_url':
					case 'lookup_host':
						continue;

					default:
						if (o.deps.length)
							for (var j = 0; j < o.deps.length; j++) {
								o.deps[j].service_name = service;
								o.deps[j].use_ipv6 = ipv6;
							}
						else
							o.depends({service_name: service, use_ipv6: ipv6 });
					}
				}
			}, this)
		)};

		o = s.option(form.DummyValue, '_cfg_status', _('Status'));
		o.modalonly = false;
		o.textvalue = section_id => resolved[section_id]?.pid 
			? `<b>${_('Running')}</b> : ${resolved[section_id].pid}` 
			: `<b>${_('Not Running')}</b>`;


		o = s.option(form.DummyValue, '_cfg_name', _('Name'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			return '<b>' + section_id + '</b>';
		};

		o = s.option(form.DummyValue, '_cfg_detail_ip', _('Lookup Hostname') + "<br />" + _('Registered IP'));
		o.rawhtml   = true;
		o.modalonly = false;
		o.textvalue = function(section_id) {
			const host = uci.get('ddns', section_id, 'lookup_host') || _('Configuration Error');
			const ip = resolved[section_id]?.ip || _('No Data');

			return host + '<br />' + ip;
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.rmempty  = false;
		o.editable = true;
		o.modalonly = false;

		o = s.option(form.DummyValue, '_cfg_update', _('Last Update') + "<br />" + _('Next Check') + "<br />" + _('Next Update'));
		o.rawhtml   = true;
		o.modalonly = false;
		o.textvalue = function(section_id) {
			const last_update = resolved[section_id]?.last_update || _('Never');
			const next_check = _this.NextUpdateStrings[resolved[section_id]?.next_check] || resolved[section_id]?.next_check || _('Unknown');
			const next_update = _this.NextUpdateStrings[resolved[section_id]?.next_update] || resolved[section_id]?.next_update || _('Unknown');
			return  last_update + '<br />' + next_check + '<br />' + next_update;
		};

		return m.render().then(L.bind(function(m, nodes) {
			poll.add(L.bind(function() {
				return Promise.all([
					this.callDDnsGetServicesStatus(),
					this.callDDnsGetStatus()
				]).then(L.bind(this.poll_status, this, nodes));
			}, this), 5);
			return nodes;
		}, this, m));
	}
});
