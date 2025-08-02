# Example Dockerfile for testing CVE fix tool
FROM ubuntu:19.10

LABEL maintainer="hackathon-team"
LABEL description="Example vulnerable Dockerfile for CVE fix demo"

# Install basic packages
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Add a simple script
RUN echo '#!/bin/bash\necho "Hello from vulnerable container with Ubuntu 18.04!"' > /app/hello.sh && \
    chmod +x /app/hello.sh

# Expose port
EXPOSE 8080

# Default command
CMD ["/app/hello.sh"] 
