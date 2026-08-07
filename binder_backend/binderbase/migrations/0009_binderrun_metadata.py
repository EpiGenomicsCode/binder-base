from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('binderbase', '0008_binder_binder_run_rank_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='binderrun',
            name='metadata',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
