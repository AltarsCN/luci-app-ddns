'use strict';
'require baseclass';
'require rpc';
'require uci';

return baseclass.extend({
	title: _('Dynamic DNS'),

	callDDnsGetServicesStatus: rpc.declare({
		object: 'luci.ddns',
		method: 'get_services_status',
		expect: {  }
	}),

	load: function() {
		return Promise.all([
			this.callDDnsGetServicesStatus(),
			uci.load('ddns')
		]);
	},

	render: function(data) {
		var services = data[0];
		var serviceKeys = Object.keys(services);

		if (serviceKeys.length === 0) {
			return E('div', { 'class': 'alert-message notice' }, [
				E('p', {}, [
					E('em', {}, _('There is no DDNS service configured.')),
					' ',
					E('a', { 'href': L.url('admin', 'services', 'ddns') }, _('Configure DDNS'))
				])
			]);
		}

		var table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Service')),
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th' }, _('Lookup Hostname')),
				E('th', { 'class': 'th' }, _('Registered IP')),
				E('th', { 'class': 'th' }, _('Last Update')),
				E('th', { 'class': 'th' }, _('Network'))
			])
		]);

		var getStatusBadge = function(service, enabled) {
			if (enabled !== '1') {
				return E('span', { 
					'class': 'badge', 
					'style': 'background-color:#888; color:white; padding:2px 6px; border-radius:3px; font-size:0.85em;' 
				}, _('Disabled'));
			}
			if (service.pid) {
				return E('span', { 
					'class': 'badge', 
					'style': 'background-color:#5cb85c; color:white; padding:2px 6px; border-radius:3px; font-size:0.85em;' 
				}, _('Running'));
			}
			return E('span', { 
				'class': 'badge', 
				'style': 'background-color:#d9534f; color:white; padding:2px 6px; border-radius:3px; font-size:0.85em;' 
			}, _('Stopped'));
		};

		cbi_update_table(table, serviceKeys.map(function(key) {
			var service = services[key];
			var enabled = uci.get('ddns', key, 'enabled');
			var useIpv6 = uci.get('ddns', key, 'use_ipv6') === '1';
			var iface = uci.get('ddns', key, 'interface') || '-';
			var lookupHost = uci.get('ddns', key, 'lookup_host') || _('Not configured');
			var serviceName = uci.get('ddns', key, 'service_name') || _('Custom');

			return [
				E('span', { 'style': 'font-weight:bold;' }, key),
				getStatusBadge(service, enabled),
				lookupHost,
				service.ip ? E('code', { 'style': 'font-size:0.9em;' }, service.ip) : E('em', {}, _('No Data')),
				service.last_update || E('em', {}, _('Never')),
				E('span', {}, [
					E('span', { 
						'style': 'display:inline-block; padding:1px 4px; border-radius:2px; font-size:0.8em; ' + 
							(useIpv6 ? 'background:#e7f3ff; color:#0066cc;' : 'background:#f0f0f0; color:#333;')
					}, useIpv6 ? 'IPv6' : 'IPv4'),
					' ',
					iface
				])
			];
		}), E('em', _('There is no DDNS service configured.')));

		return E([table]);
	}
});
