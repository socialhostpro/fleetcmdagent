#!/bin/bash
# Portainer Integration for Fleet Commander
#
# NOTE: Portainer Agent has compatibility issues with Docker Swarm nodes.
# The agents crash due to DNS resolution failures for 'tasks.' hostname.
#
# RECOMMENDED: Add your Docker Swarm directly to Portainer instead.

echo "============================================="
echo "  Portainer Integration for Docker Swarm"
echo "============================================="
echo ""
echo "Portainer Agent doesn't work well on Swarm nodes due to DNS issues."
echo ""
echo "RECOMMENDED APPROACH:"
echo "  1. Open Portainer: https://192.168.1.214:9443"
echo "  2. Go to Environments → Add environment"
echo "  3. Select 'Docker Swarm'"
echo "  4. Name: 'Fleet Swarm'"
echo "  5. Docker API URL: tcp://192.168.1.214:2375"
echo "  6. Click 'Add environment'"
echo ""
echo "This gives you full Swarm management in Portainer including:"
echo "  - All nodes visible"
echo "  - Service management"
echo "  - Container logs"
echo "  - Stack deployments"
echo ""
echo "For standalone Docker hosts (like Windows PCs with GPUs):"
echo "  - Portainer Agent works fine"
echo "  - Run: ./windows-deploy-containers.ps1 -PortainerAgent"
echo ""
echo "Your nodes are already managed by Fleet Commander at:"
echo "  http://192.168.1.214:3000"
echo ""
