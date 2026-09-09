# TURANT Deployment Guide

**Version:** 1.0.0  
**Last Updated:** 2026-08-19

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Environment Configuration](#environment-configuration)
4. [Docker Deployment](#docker-deployment)
5. [Production Deployment](#production-deployment)
6. [Monitoring & Maintenance](#monitoring--maintenance)
7. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Local Development with Docker

```bash
# 1. Copy environment file
cp .env.example .env

# 2. Edit .env with your configuration
nano .env

# 3. Start all services
docker-compose up -d

# 4. Check health
curl http://localhost:8080/healthz
curl http://localhost/health

# 5. Access application
open http://localhost
```

---

## Prerequisites

### Required Software

- **Docker** 20.10+ and Docker Compose 2.0+
- **Java** 21+ (for local development)
- **Maven** 3.9+ (for local development)
- **Node.js** 20+ (for frontend development)
- **PostgreSQL** 16+ with PostGIS 3.4+ (if not using Docker)
- **Redis** 7+ (if not using Docker)

### Optional

- **SMPP Gateway** credentials (for real SMS sending)
- **Kubernetes** cluster (for production deployment)
- **Monitoring tools** (Prometheus, Grafana)

---

## Environment Configuration

### 1. Create Environment File

```bash
cp .env.example .env
```

### 2. Configure Required Variables

```bash
# Database
POSTGRES_PASSWORD=your_secure_password_here

# Redis
REDIS_PASSWORD=your_redis_password_here

# Spring Profile
SPRING_PROFILES_ACTIVE=production  # or staging, development
```

### 3. Configure Optional SMPP (for real SMS)

```bash
# SMPP Gateway
SMPP_HOST=smpp.your-provider.com
SMPP_PORT=2775
SMPP_SYSTEM_ID=your_system_id
SMPP_PASSWORD=your_smpp_password

# Disable simulation mode
SIMULATION_MODE=disabled
```

---

## Docker Deployment

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Docker Compose Stack                                   │
├─────────────────────────────────────────────────────────┤
│  Frontend (nginx)          → Port 80                    │
│  Backend (Spring Boot)     → Port 8080                  │
│  PostgreSQL + PostGIS      → Port 5432                  │
│  Redis                     → Port 6379                  │
└─────────────────────────────────────────────────────────┘
```

### Build Images

```bash
# Build all images
docker-compose build

# Build specific service
docker-compose build backend
docker-compose build frontend
```

### Start Services

```bash
# Start all services in background
docker-compose up -d

# Start with logs visible
docker-compose up

# Start specific services
docker-compose up -d postgres redis
docker-compose up -d backend
docker-compose up -d frontend
```

### Check Status

```bash
# View running containers
docker-compose ps

# View logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Check health
curl http://localhost:8080/healthz
curl http://localhost/health
```

### Stop Services

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (WARNING: deletes data)
docker-compose down -v
```

---

## Production Deployment

### Option 1: Docker Compose (Small Scale)

**Suitable for:** Single server, up to 10K users

```bash
# 1. Configure production environment
export SPRING_PROFILES_ACTIVE=production
export SIMULATION_MODE=disabled

# 2. Start services
docker-compose up -d

# 3. Setup backup cron job
crontab -e
# Add: 0 2 * * * docker exec turant-postgres pg_dump -U turant turant > /backups/turant-$(date +%Y%m%d).sql
```

### Option 2: Kubernetes (Large Scale)

**Suitable for:** Multiple servers, 10K+ users, high availability

Create Kubernetes manifests:

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: turant

---
# k8s/backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: turant-backend
  namespace: turant
spec:
  replicas: 3
  selector:
    matchLabels:
      app: turant-backend
  template:
    metadata:
      labels:
        app: turant-backend
    spec:
      containers:
      - name: backend
        image: turant/backend:latest
        ports:
        - containerPort: 8080
        env:
        - name: SPRING_PROFILES_ACTIVE
          value: "production"
        resources:
          requests:
            memory: "1Gi"
            cpu: "1000m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
```

Deploy to Kubernetes:

```bash
# Apply manifests
kubectl apply -f k8s/

# Check deployment
kubectl get pods -n turant
kubectl get services -n turant

# View logs
kubectl logs -f deployment/turant-backend -n turant
```

### Option 3: Cloud Platforms

#### AWS (Elastic Beanstalk or ECS)

```bash
# 1. Build and push images
docker build -t turant/backend:latest .
docker push your-registry/turant/backend:latest

# 2. Deploy to ECS/Fargate
aws ecs create-service --cluster turant-cluster \
  --service-name turant-backend \
  --task-definition turant-backend:1 \
  --desired-count 2
```

#### Google Cloud (Cloud Run)

```bash
# Build and deploy
gcloud run deploy turant-backend \
  --image gcr.io/your-project/turant-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

#### Azure (Container Instances or App Service)

```bash
# Deploy to Azure Container Instances
az container create \
  --resource-group turant-rg \
  --name turant-backend \
  --image your-registry/turant/backend:latest \
  --dns-name-label turant-backend \
  --ports 8080
```

---

## Monitoring & Maintenance

### Health Checks

```bash
# Backend health
curl http://localhost:8080/healthz

# Frontend health
curl http://localhost/health

# Detailed backend health
curl http://localhost:8080/actuator/health

# Metrics (Prometheus format)
curl http://localhost:8080/actuator/prometheus
```

### Logs

```bash
# View logs
docker-compose logs -f backend
docker-compose logs -f frontend

# View specific time range
docker-compose logs --since 1h backend

# Export logs
docker-compose logs backend > backend-logs.txt
```

### Metrics Collection (Prometheus)

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'turant-backend'
    static_configs:
      - targets: ['backend:8080']
    metrics_path: '/actuator/prometheus'
    scrape_interval: 15s
```

### Database Backup

```bash
# Manual backup
docker exec turant-postgres pg_dump -U turant turant > backup-$(date +%Y%m%d).sql

# Restore backup
docker exec -i turant-postgres psql -U turant turant < backup-20260819.sql

# Automated backup script
#!/bin/bash
BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d-%H%M%S)
docker exec turant-postgres pg_dump -U turant turant | gzip > $BACKUP_DIR/turant-$DATE.sql.gz
# Keep only last 30 days
find $BACKUP_DIR -name "turant-*.sql.gz" -mtime +30 -delete
```

### Performance Tuning

**Backend JVM Options:**
```bash
# For high throughput (4GB RAM)
JAVA_OPTS="-Xmx3g -Xms2g -XX:+UseG1GC -XX:MaxGCPauseMillis=200"

# For low latency (2GB RAM)
JAVA_OPTS="-Xmx1536m -Xms1g -XX:+UseZGC"
```

**PostgreSQL Tuning:**
```sql
-- For 8GB RAM server
ALTER SYSTEM SET shared_buffers = '2GB';
ALTER SYSTEM SET effective_cache_size = '6GB';
ALTER SYSTEM SET maintenance_work_mem = '512MB';
ALTER SYSTEM SET work_mem = '64MB';
ALTER SYSTEM SET max_connections = 200;
SELECT pg_reload_conf();
```

---

## Troubleshooting

### Backend Won't Start

**Problem:** `Connection refused` to database

**Solution:**
```bash
# Check database is running
docker-compose ps postgres

# Check database logs
docker-compose logs postgres

# Restart database
docker-compose restart postgres
```

**Problem:** `OutOfMemoryError`

**Solution:**
```bash
# Increase memory limit in docker-compose.yml
services:
  backend:
    deploy:
      resources:
        limits:
          memory: 4G  # Increase from 2G

# Or increase JVM heap
environment:
  JAVA_OPTS: "-Xmx2g -Xms1g"
```

### Frontend Not Loading

**Problem:** API requests failing

**Solution:**
```bash
# Check backend health
curl http://backend:8080/healthz

# Check nginx logs
docker-compose logs frontend

# Verify nginx config
docker exec turant-frontend nginx -t
```

### Database Performance Issues

**Problem:** Slow queries

**Solution:**
```sql
-- Check slow queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;

-- Add missing indexes
CREATE INDEX idx_subscriber_cell ON subscriber_dump(cell_id);
CREATE INDEX idx_tower_location ON cell_towers USING GIST(location);
```

### High Memory Usage

**Problem:** Backend using too much memory

**Solution:**
```bash
# Check memory usage
docker stats turant-backend

# Reduce connection pool
# In application-production.properties:
spring.datasource.hikari.maximum-pool-size=10

# Reduce JVM heap
JAVA_OPTS="-Xmx512m -Xms256m"
```

### SMPP Connection Issues

**Problem:** Cannot connect to SMPP gateway

**Solution:**
```bash
# Test connection manually
telnet smpp.provider.com 2775

# Check credentials
docker exec turant-backend env | grep SMPP

# Enable SMPP debug logging
logging.level.org.jsmpp=DEBUG

# Check backend logs
docker-compose logs backend | grep -i smpp
```

---

## Upgrade Procedures

### Rolling Update (Zero Downtime)

```bash
# 1. Build new image
docker-compose build backend

# 2. Scale up new version
docker-compose up -d --scale backend=2 backend

# 3. Wait for health checks
sleep 30

# 4. Remove old version
docker-compose up -d --scale backend=1 backend
```

### Database Migration

```bash
# 1. Backup database
docker exec turant-postgres pg_dump -U turant turant > pre-upgrade-backup.sql

# 2. Apply migrations
docker exec turant-backend java -jar app.jar --spring.jpa.hibernate.ddl-auto=update

# 3. Verify migration
docker exec -it turant-postgres psql -U turant turant -c "\dt"
```

---

## Security Checklist

### Before Production Deployment

- [ ] Change all default passwords
- [ ] Enable HTTPS/TLS
- [ ] Configure firewall rules
- [ ] Setup database backups
- [ ] Enable audit logging
- [ ] Configure rate limiting
- [ ] Review CORS settings
- [ ] Enable security headers
- [ ] Setup monitoring alerts
- [ ] Document recovery procedures
- [ ] Test disaster recovery
- [ ] Setup log aggregation
- [ ] Configure secrets management
- [ ] Enable database encryption at rest
- [ ] Setup VPN/private network

---

## Performance Benchmarks

**Expected Performance (4-core, 8GB RAM):**
- Throughput: 15,000+ messages/second
- Latency: <100ms (p99)
- Concurrent users: 1,000+
- Database connections: 20
- Memory usage: 1-2GB (backend)

**Load Testing:**
```bash
# Install Apache Bench
apt-get install apache2-utils

# Test backend endpoint
ab -n 10000 -c 100 http://localhost:8080/healthz

# Test alert creation
ab -n 1000 -c 10 -p alert.json -T application/json \
  http://localhost:8080/api/v1/alerts/manual
```

---

## Disaster Recovery

### Backup Strategy

**Daily:**
- Full database backup
- Redis snapshot

**Hourly:**
- Incremental database backup
- Application logs

**Real-time:**
- WAL archiving (PostgreSQL)
- Log streaming to S3/Cloud Storage

### Recovery Procedures

**Database Corruption:**
```bash
# Restore from latest backup
docker exec -i turant-postgres psql -U turant turant < latest-backup.sql

# Restart services
docker-compose restart backend
```

**Complete System Failure:**
```bash
# Restore from backup on new server
scp backups/latest-backup.sql new-server:/tmp/
ssh new-server "docker-compose up -d"
ssh new-server "docker exec -i turant-postgres psql -U turant turant < /tmp/latest-backup.sql"
```

---

## Support

For issues or questions:
- **GitHub Issues**: [turant/issues](https://github.com/turant/issues)
- **Documentation**: `COMPLETE_MIGRATION_GUIDE.md`
- **API Reference**: `API_DOCUMENTATION.md`

---

**Deployment guide ready! Start with `docker-compose up -d`** 🚀
