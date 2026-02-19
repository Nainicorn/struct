# Use standard Python image (has more packages available)
FROM python:3.11-slim

# Install IfcOpenShell and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && pip install --no-cache-dir -q \
    ifcopenshell \
    numpy \
    shapely \
    isodate \
    lark \
    python-dateutil \
    && rm -rf /var/lib/apt/lists/*

# Create Lambda runtime directory
WORKDIR /var/task

# Copy Lambda handler code
COPY lambda_function.py /var/task/

# Install AWS Lambda runtime interface client
RUN pip install --no-cache-dir -q \
    awslambdaric

# Copy entry point script
COPY entry.sh /var/task/
RUN chmod +x /var/task/entry.sh

# Set the entry point
ENTRYPOINT ["/var/task/entry.sh"]
CMD ["lambda_function.handler"]
