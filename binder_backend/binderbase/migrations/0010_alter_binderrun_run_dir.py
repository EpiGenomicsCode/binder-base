from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('binderbase', '0009_binderrun_metadata'),
    ]

    operations = [
        migrations.AlterField(
            model_name='binderrun',
            name='run_dir',
            field=models.CharField(blank=True, max_length=1024, null=True, unique=True),
        ),
    ]
