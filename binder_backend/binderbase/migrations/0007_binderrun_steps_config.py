from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('binderbase', '0006_binderrun_target_sequence'),
    ]

    operations = [
        migrations.AddField(
            model_name='binderrun',
            name='steps_config',
            field=models.JSONField(blank=True, default=dict, null=True),
        ),
    ]
