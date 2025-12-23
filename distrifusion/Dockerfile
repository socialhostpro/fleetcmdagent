FROM 192.168.1.214:5000/stable-diffusion-webui:r35.4.1

# Install distributed requirements (pin older diffusers for PyTorch 2.0 compat)
RUN pip3 install --no-cache-dir \
    "diffusers==0.21.4" \
    "accelerate==0.24.0" \
    pynvml \
    redis \
    flask

# Create working directory
WORKDIR /workspace

# Copy the distributed runner script
COPY run_distributed.py /workspace/

# Expose port for distributed communication
EXPOSE 29500

# Default command
CMD ["python3", "/workspace/run_distributed.py"]
