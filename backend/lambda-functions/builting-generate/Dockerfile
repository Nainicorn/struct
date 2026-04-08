FROM amazonlinux:2023

RUN yum -y update && \
    yum -y install tar gzip bzip2 ca-certificates && \
    yum clean all

ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "64") && \
    curl -Ls "https://micro.mamba.pm/api/micromamba/linux-${ARCH}/latest" | \
    tar -xvj -C /usr/local/bin --strip-components=1 bin/micromamba

ENV MAMBA_ROOT_PREFIX=/opt/conda
RUN micromamba create -y -n ifc -c conda-forge python=3.11 ifcopenshell && \
    micromamba clean -a -y

ENV PATH="/opt/conda/envs/ifc/bin:${PATH}"
ENV PYTHONPATH="/var/task:/opt/conda/envs/ifc/lib/python3.11/site-packages"

RUN /opt/conda/envs/ifc/bin/python -m pip install --no-cache-dir awslambdaric

COPY requirements.txt /var/task/requirements.txt
RUN /opt/conda/envs/ifc/bin/python -m pip install --no-cache-dir -r /var/task/requirements.txt

ARG BUILD_VERSION=1
ENV LAMBDA_BUILD_VERSION=$BUILD_VERSION
COPY lambda_function.py /var/task/lambda_function.py
COPY lambda_package/ /var/task/lambda_package/

ENTRYPOINT ["/opt/conda/envs/ifc/bin/python", "-m", "awslambdaric"]
CMD ["lambda_function.handler"]
