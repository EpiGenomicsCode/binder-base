from django.urls import path
from .api import api

api = NinjaAPI()

urlpatterns = [
    path("api/", api.urls),
]
