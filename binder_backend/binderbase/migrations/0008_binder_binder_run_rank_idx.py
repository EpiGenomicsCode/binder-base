from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('binderbase', '0007_binderrun_steps_config'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='binder',
            index=models.Index(fields=['run', 'final_rank'], name='binder_run_rank_idx'),
        ),
    ]
