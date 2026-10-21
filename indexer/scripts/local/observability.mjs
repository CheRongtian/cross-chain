// Only deployment scripts read and prepare Grafana/Prometheus configuration.
import { access,mkdir,readFile,realpath,writeFile } from "node:fs/promises";
import { dirname,join } from "node:path";
import YAML from "yaml";
import { ROOT,binary } from "./tools.mjs";

export async function observabilityTools() {
  const prometheus = await binary("prometheus",process.env.PROMETHEUS_BIN);
  const grafana = await binary("grafana",process.env.GRAFANA_BIN);
  const candidates = process.env.GRAFANA_HOME ? [process.env.GRAFANA_HOME] : [
    join(dirname(await realpath(grafana)),"../share/grafana"),join(dirname(await realpath(grafana)),".."),
  ];
  let home;
  for (const candidate of candidates) {
    try { await access(join(candidate,"conf/defaults.ini")); home = candidate; break; } catch { /* next installed home */ }
  }
  if (!home) throw new Error("Set GRAFANA_HOME in .env to the existing Grafana installation containing conf/defaults.ini");
  return { prometheus,grafana,home };
}

export async function observabilityConfiguration(config) {
  const { prometheus,grafana,home } = await observabilityTools();
  const directory = join(config.directory,"observability");
  const provisioning = join(directory,"provisioning");
  for (const path of ["datasources","dashboards"]) await mkdir(join(provisioning,path),{ recursive: true,mode: 0o700 });
  const prometheusConfig = YAML.parse(await readFile(join(ROOT,"observability/prometheus/prometheus.example.yml"),"utf8"));
  for (const job of prometheusConfig.scrape_configs) {
    const ports = job.job_name === "cross-chain-api" ? [config.ports.api] :
      job.job_name === "cross-chain-workers" ? config.ports.metrics : config.ports.validators;
    job.static_configs = [{ targets: ports.map(port => `127.0.0.1:${port}`) }];
  }
  await writeFile(join(directory,"prometheus.yml"),YAML.stringify(prometheusConfig),{ mode: 0o600 });
  const datasource = YAML.parse(await readFile(join(ROOT,"observability/grafana/provisioning/datasources/prometheus.yaml"),"utf8"));
  datasource.datasources[0].url = config.prometheus;
  await writeFile(join(provisioning,"datasources/prometheus.yaml"),YAML.stringify(datasource),{ mode: 0o600 });
  const dashboard = YAML.parse(await readFile(join(ROOT,"observability/grafana/provisioning/dashboards/cross-chain.yaml"),"utf8"));
  dashboard.providers[0].options.path = join(ROOT,"observability/grafana/dashboards");
  await writeFile(join(provisioning,"dashboards/cross-chain.yaml"),YAML.stringify(dashboard),{ mode: 0o600 });
  const grafanaConfig = join(directory,"grafana.ini");
  await writeFile(grafanaConfig,"[server]\nhttp_addr = 127.0.0.1\nhttp_port = " + config.ports.grafana +
    "\n[paths]\ndata = " + join(directory,"grafana-data") + "\nlogs = " + join(config.directory,"logs") +
    "\nplugins = " + join(directory,"plugins") + "\nprovisioning = " + provisioning +
    "\n[auth.anonymous]\nenabled = true\norg_role = Viewer\n[analytics]\nreporting_enabled = false\ncheck_for_updates = false\ncheck_for_plugin_updates = false" +
    "\n[plugins]\npreinstall_disabled = true\npublic_key_retrieval_disabled = true\n",{ mode: 0o600 });
  return { prometheus,grafana,home,grafanaConfig,directory,provisioning };
}
