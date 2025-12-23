# Fleet Commander Node Installation Guide

## Option 1: Git Clone (Recommended)

We host a local read-only Git repository on the Spark node.

Run this on each AGX node:

```bash
# 1. Clone the bootstrap repository
git clone git://192.168.1.100/bootstrap.git fleet-bootstrap

# 2. Enter directory
cd fleet-bootstrap

# 3. Run the installer (requires sudo)
sudo ./bootstrap-node.sh
```

## Option 2: Curl (Fastest)

If you just want to run the script without cloning:

```bash
curl -s http://192.168.1.100:8765/install/bootstrap-node.sh | sudo bash
```

## Post-Install Verification

After installation, the node should:
1. Appear in the Fleet Commander UI
2. Be joined to the Docker Swarm
3. Have the Fleet Agent running
