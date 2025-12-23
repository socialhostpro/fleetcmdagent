import axios from 'axios';

const API_URL = `http://${window.location.hostname}:8765/api`;

export const api = axios.create({
  baseURL: API_URL,
});

export const fetchNodes = async () => {
  const response = await api.get('/nodes/');
  return response.data;
};

export const fetchSwarmStatus = async () => {
  const response = await api.get('/swarm/status');
  return response.data;
};

export const fetchNetworkScan = async (subnet = '192.168.1.0/24', refresh = false) => {
  const response = await api.get('/network/scan', { params: { subnet, refresh } });
  return response.data;
};

export const fetchCredentials = async () => {
  const response = await api.get('/vault/');
  return response.data;
};

export const saveCredential = async (cred) => {
  const response = await api.post('/vault/', cred);
  return response.data;
};

export const installNode = async (host, credentialId) => {
  const sparkIp = window.location.hostname;
  const response = await api.post('/install/node', { 
    host, 
    credential_id: credentialId,
    spark_ip: sparkIp
  });
  return response.data;
};

export const getInstallStatus = async (taskId) => {
  const response = await api.get(`/install/status/${taskId}`);
  return response.data;
};
