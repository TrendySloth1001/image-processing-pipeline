"""Stateless face-processing microservice: queue in, webhook out.

The service keeps no data of its own. A job arrives on a Redis stream, a worker fetches the
photo from object storage, finds and embeds the faces, and posts the result to the caller's
webhook, retrying until the caller acknowledges it with a 2xx.
"""
