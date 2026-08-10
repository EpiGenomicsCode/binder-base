from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('binderbase', '0010_alter_binderrun_run_dir'),
    ]

    operations = [
        migrations.RenameField(
            model_name='binderrun',
            old_name='algorithm_version',
            new_name='algorithm',
        ),
    ]
