# Deployment examples

Preview the development environment:

```sh
argrail-demo deploy --environment dev --replicas 2 --dry-run
```

Preview the production environment:

```sh
argrail-demo deploy --environment production --replicas 3 --dry-run
```

The replica count must be between 1 and 20. This demo never contacts a deployment
service.
